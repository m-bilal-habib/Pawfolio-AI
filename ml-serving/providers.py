"""VoxSOAP ML serving providers (Phase 4 scaffold).

Design rules taken directly from the feature contract and the run 1-8 lessons:

* Adapter-not-a-model compatibility: every LoRA adapter directory MUST carry
  a training_manifest.json whose base_model_id/revision matches the
  configured base checkpoint. Serving REFUSES to load a mismatch - pairing an
  adapter with the wrong base would produce plausible-looking garbage.
* Lazy loading: importing this module (and starting uvicorn) must NOT import
  torch or load any weights. Weights load on the first request that needs
  them and can be dropped again with unload() - the Windows RAM safeguard for
  the unquantized 3B-class SOAP base (bitsandbytes 4-bit is Linux-only).
* Provider isolation: ML and Gemini-proxy providers never substitute for each
  other. A failed ML call raises InferenceError and the API layer turns it
  into a controlled 5xx. The Gemini provider is used only when the REQUEST
  explicitly selects provider="gemini" (or VOXSOAP_DEFAULT_PROVIDER=gemini).
* model_scale: every response carries a scale label with an explicit source,
  never fabricated (see resolve_scale).
"""
from __future__ import annotations

# Run-5 lesson: set the transformers guard env BEFORE any transformers import.
# All transformers imports here are lazy (inside loaders), but the guard must
# already be set for whichever module triggers the first import.
import os as _boot_os

_boot_os.environ.setdefault("USE_TF", "0")
_boot_os.environ.setdefault("USE_FLAX", "0")

import base64
import copy
import gc
import json
import time
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

# Kept in byte-for-byte sync with train_transliteration_lora.py and
# evaluate_transliteration.py (the EXACT same prefix must be used in serving).
TASK_PREFIX = "transliterate to roman urdu: "

COMPONENT_KEYS = ("asr", "soap", "roman")


# ---- transformers cross-version helpers ------------------------------------
# The 2026-10-30 Colab real-inference gate caught an unpinned-resolve drift:
# `apply_chat_template(..., tokenize=True, return_tensors="pt")` returns a raw
# torch.Tensor on the VERIFIED 4.48.3 stack, but a BatchEncoding mapping on
# newer transformers - whose `.shape` access raised KeyError('shape'). The
# exact runtime is pinned in requirements-serving-ml.txt, and these helpers
# accept BOTH shapes so call-sites survive any future re-pin honestly.

def _unwrap_chat_prompt(prompt: Any) -> Tuple[Any, Optional[Any]]:
    """Return (input_ids, attention_mask|None) from either template return shape."""
    ids = prompt["input_ids"] if hasattr(prompt, "input_ids") else prompt
    return ids, getattr(prompt, "attention_mask", None)


def _prep_dtype_kwargs(torch_dtype: Any) -> Dict[str, Any]:
    """`from_pretrained` renamed torch_dtype -> dtype in newer transformers.
    Choose the kwarg from the INSTALLED version instead of relying on warning
    text - the wrong kwarg either TypeErrors or emits a deprecation warning."""
    try:
        import transformers

        parts = str(transformers.__version__).split(".")
        if (int(parts[0]), int(parts[1])) >= (4, 56):
            return {"dtype": torch_dtype}
    except Exception:
        pass  # version unreadable -> keep the long-standing kwarg name
    return {"torch_dtype": torch_dtype}


class ProviderError(Exception):
    """Controlled, honest provider failure - the API layer maps it to JSON."""

    status_code = 500
    code = "provider_error"

    def __init__(self, message: str, *, detail: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.message = message
        self.detail = detail or {}


class BadRequest(ProviderError):
    status_code = 400
    code = "bad_request"


class NotConfigured(ProviderError):
    status_code = 501
    code = "not_configured"


class UnknownProvider(ProviderError):
    status_code = 400
    code = "unknown_provider"


class InferenceError(ProviderError):
    status_code = 503
    code = "inference_error"


class CompatibilityError(ProviderError):
    status_code = 503
    code = "adapter_compatibility_error"


def manifest_read(adapter_dir: Optional[Path]) -> Optional[Dict[str, Any]]:
    """Read a training manifest. None when absent, marker-dict when corrupt.

    Never raises: scale labels and /health must stay available even when the
    manifest is missing or unreadable.
    """
    if not adapter_dir:
        return None
    path = Path(adapter_dir) / "training_manifest.json"
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"_corrupt_manifest": True}


def resolve_scale(manifest: Optional[Dict[str, Any]]) -> Tuple[str, str]:
    """(label, source) - explicit, non-fabricating model_scale resolution.

    Precedence:
      1. manifest["model_scale"]  (phase-3 artifacts; tagged at train time)
      2. derived from train_rows  (phase-2 artifacts predating the tag)
      3. UNKNOWN(...)             (nothing to read)
    <=500 train rows was the largest phase-2 smoke cap (ASR 180, SOAP 100);
    phase-3 full-scale begins at 400/1200/2000, so the threshold cleanly
    separates the generations.
    """
    if manifest and not manifest.get("_corrupt_manifest"):
        tag = manifest.get("model_scale")
        if tag:
            return str(tag).upper(), "training_manifest.model_scale"
        rows = manifest.get("train_rows")
        if isinstance(rows, int) and rows >= 0:
            if rows <= 500:
                return "SMOKE(assumed: manifest predates the model_scale tag; small train_rows)", "derived_from_train_rows"
            return "UNTAGGED(assumed: manifest predates the model_scale tag; larger train_rows)", "derived_from_train_rows"
    if manifest and manifest.get("_corrupt_manifest"):
        return "UNKNOWN(corrupt training_manifest.json)", "unreadable"
    return "UNKNOWN(no training_manifest.json in the adapter dir)", "missing_manifest"


class MLProvider:
    """Lazy-loading local provider for the VoxSOAP ML components.

    Nothing imports or loads anything heavy until a request asks for a
    component. unload() drops references and (when torch is present and CUDA
    is in use) empties the CUDA cache - the Windows RAM safeguard.
    """

    name = "ml"
    is_mock = False

    def __init__(self, cfg: Any):
        self._cfg = cfg
        self.components: Dict[str, Dict[str, Any]] = {
            "asr": {
                "adapter_dir": cfg.asr_adapter_dir,
                "base_model": cfg.asr_base_model,
                "base_revision": cfg.asr_base_revision,
            },
            "soap": {
                "adapter_dir": cfg.soap_adapter_dir,
                "base_model": cfg.soap_base_model,
                "base_revision": cfg.soap_base_revision,
            },
            "roman": {
                "adapter_dir": getattr(cfg, "roman_adapter_dir", None),
                "base_model": getattr(cfg, "roman_base_model", "google/mt5-small"),
                "base_revision": getattr(cfg, "roman_base_revision", "main"),
            },
        }
        self._loaded: Dict[str, Optional[Dict[str, Any]]] = {k: None for k in COMPONENT_KEYS}

    # ---------- introspection (no heavy imports; safe for /health) ----------

    def scale_for(self, key: str) -> Tuple[str, str]:
        if key not in self.components:
            raise UnknownProvider(f"unknown component {key!r}")
        return resolve_scale(manifest_read(self.components[key]["adapter_dir"]))

    def describe(self) -> Dict[str, Dict[str, Any]]:
        out: Dict[str, Dict[str, Any]] = {}
        for key in COMPONENT_KEYS:
            try:
                comp = self.components[key]
                adapter_dir = comp["adapter_dir"]
                files_ok = False
                if adapter_dir and (Path(adapter_dir) / "adapter_config.json").is_file() \
                        and (Path(adapter_dir) / "adapter_model.safetensors").is_file():
                    files_ok = True
                scale_label, scale_source = resolve_scale(manifest_read(adapter_dir))
                out[key] = {
                    "adapter_dir": str(adapter_dir) if adapter_dir else None,
                    "configured": adapter_dir is not None,
                    "adapter_files_present": files_ok,
                    "base_model": comp["base_model"],
                    "base_revision": comp["base_revision"],
                    "model_scale": scale_label,
                    "model_scale_source": scale_source,
                    "loaded": self._loaded[key] is not None,
                }
            except Exception as err:  # never break /health over introspection
                out[key] = {"error": f"{type(err).__name__}: {err}"}
        return out

    # ---------- validation ----------

    def _require_adapter(self, key: str) -> Dict[str, Any]:
        comp = self.components[key]
        adapter_dir = comp["adapter_dir"]
        if adapter_dir is None:
            if key == "roman":
                raise NotConfigured(
                    "/roman is intentionally a 501 by design: Model C (mT5 Roman Urdu transliteration) was DEPRECATED on "
                    "2026-10-29 after three training recipes failed their evaluations (runs 9/10/11: sentinel collapse, "
                    "then loss plateau, then repetition loops; CER 6.8905, exact_match 0.0). VOXSOAP_ROMAN_ADAPTER_DIR "
                    "remains a diagnostics-only override requiring a training_manifest.json + adapter_model.safetensors "
                    "from a supervised owner-approved re-enable attempt. Nothing was silently substituted (no Gemini fallback).",
                )
            raise NotConfigured(
                f"{key.upper()} adapter directory is not configured; set the VOXSOAP_{key.upper()}_ADAPTER_DIR env var."
            )
        d = Path(adapter_dir)
        missing = [f for f in ("adapter_config.json", "adapter_model.safetensors") if not (d / f).is_file()]
        if missing:
            raise NotConfigured(
                f"{key.upper()} adapter directory {d} is missing {', '.join(missing)} - an adapter without its "
                "files is NOT usable and nothing was fabricated or substituted."
            )
        manifest = manifest_read(d)
        if manifest and not manifest.get("_corrupt_manifest"):
            manifest_base = manifest.get("base_model_id")
            if manifest_base and manifest_base != comp["base_model"]:
                raise CompatibilityError(
                    f"{key.upper()} adapter manifest declares base_model_id={manifest_base!r} but serving is "
                    f"configured for base model {comp['base_model']!r}. An adapter is NOT a complete model and "
                    "MUST be paired with the exact base checkpoint it was trained on. Fix VOXSOAP_"
                    f"{key.upper()}_BASE_MODEL or point VOXSOAP_{key.upper()}_ADAPTER_DIR at a matching adapter."
                )
            manifest_rev = manifest.get("base_model_revision")
            if manifest_rev and manifest_rev != comp["base_revision"]:
                raise CompatibilityError(
                    f"{key.upper()} adapter manifest declares base_model_revision={manifest_rev!r} but serving "
                    f"is configured for revision {comp['base_revision']!r} - refusing to load a mismatched base."
                )
        elif manifest and manifest.get("_corrupt_manifest"):
            raise CompatibilityError(
                f"{key.upper()} adapter training_manifest.json in {d} is unreadable - refusing to load without "
                "verifiable base-model compatibility."
            )
        return comp

    # ---------- real-inference stack ----------

    @staticmethod
    def _real_stack():
        """Import torch/numpy/transformers/peft or raise an honest 503.

        Deliberately NOT auto-installing anything, and NOT falling back to the
        Gemini provider (never happens by design).
        """
        try:
            import numpy  # noqa: F401
            import peft  # noqa: F401
            import torch  # noqa: F401
            import transformers  # noqa: F401
            return torch
        except Exception as err:  # ImportError or broken dependency
            raise InferenceError(
                f"Real ML inference is unavailable in this Python environment: {type(err).__name__}: {err}. "
                "This machine currently runs 32-bit Python 3.15, which has no torch win32 wheels: install a "
                "64-bit interpreter with torch 2.x (CUDA build), transformers, peft, numpy, accelerate - or run "
                "the serving check on Colab. The request was NOT silently routed to Gemini."
            ) from err

    def _resolve_device(self):
        if self._cfg.device != "auto":
            return self._cfg.device
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"

    # ---------- component loaders ----------

    def _load_asr(self) -> Dict[str, Any]:
        comp = self._require_adapter("asr")
        torch = self._real_stack()
        from peft import PeftModel
        from transformers import WhisperForConditionalGeneration, WhisperProcessor

        device = self._resolve_device()
        dtype = torch.float16 if device == "cuda" else torch.float32
        processor = WhisperProcessor.from_pretrained(str(comp["adapter_dir"]))
        base = WhisperForConditionalGeneration.from_pretrained(
            comp["base_model"], revision=comp["base_revision"], **_prep_dtype_kwargs(dtype)
        )
        model = PeftModel.from_pretrained(base, str(comp["adapter_dir"]))
        model.to(device)
        model.eval()
        state = {"model": model, "processor": processor, "device": device, "loaded_at": time.time()}
        self._loaded["asr"] = state
        return state

    def _load_soap(self) -> Dict[str, Any]:
        comp = self._require_adapter("soap")
        torch = self._real_stack()
        from peft import PeftModel
        from transformers import AutoModelForCausalLM, AutoTokenizer

        device = self._resolve_device()
        dtype = torch.float16 if device == "cuda" else torch.float32
        tokenizer_src = str(comp["adapter_dir"])
        try:
            tok = AutoTokenizer.from_pretrained(tokenizer_src)
        except Exception:
            # Same checkpoint family only: the adapter's manifest base id and
            # revision were ALREADY validated against the configured base in
            # _require_adapter(), so falling back to that validated base's
            # tokenizer is safe (never a silent cross-model mix).
            tok = AutoTokenizer.from_pretrained(comp["base_model"], revision=comp["base_revision"])
        base = AutoModelForCausalLM.from_pretrained(
            comp["base_model"], revision=comp["base_revision"], **_prep_dtype_kwargs(dtype)
        )
        model = PeftModel.from_pretrained(base, str(comp["adapter_dir"]))
        model.to(device)
        model.eval()
        state = {"model": model, "tokenizer": tok, "device": device, "loaded_at": time.time()}
        self._loaded["soap"] = state
        return state

    def _load_roman(self) -> Dict[str, Any]:
        comp = self._require_adapter("roman")
        torch = self._real_stack()
        from peft import PeftModel
        from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

        device = self._resolve_device()
        # mt5/T5-family: fp32 masters (direct-fp16 NaN guard documented in the
        # training scripts). CPU-first dtype keeps that guarantee everywhere.
        base = AutoModelForSeq2SeqLM.from_pretrained(
            comp["base_model"], revision=comp["base_revision"]
        )
        model = PeftModel.from_pretrained(base, str(comp["adapter_dir"]))
        model.to(device)
        model.eval()
        tok = AutoTokenizer.from_pretrained(str(comp["adapter_dir"]))
        state = {"model": model, "tokenizer": tok, "device": device, "loaded_at": time.time()}
        self._loaded["roman"] = state
        return state

    # ---------- inference ----------

    def transcribe(self, samples, sample_rate: int, audio_bytes: Optional[bytes] = None) -> Dict[str, Any]:
        try:
            state = self._loaded["asr"] or self._load_asr()
            torch = self._real_stack()
            import numpy as np

            model = state["model"]
            processor = state["processor"]
            speech = np.asarray(samples, dtype=np.float32)
            feats = processor.feature_extractor(
                speech,
                sampling_rate=sample_rate,
                return_attention_mask=True,
                return_tensors="pt",
            )
            # max_new_tokens is the actively supported generate arg (the exact
            # recipe evaluate_asr.py used for the verified Stage-10 eval under
            # the pinned stack); `max_length` is the deprecated Whisper path.
            gen_kwargs: Dict[str, Any] = {
                "max_new_tokens": self._cfg.asr_max_new_tokens,
                "language": "urdu",
                "task": "transcribe",
            }
            if getattr(feats, "attention_mask", None) is not None:
                gen_kwargs["attention_mask"] = feats.attention_mask.to(model.device)
            with torch.no_grad():
                ids = model.generate(
                    input_features=feats.input_features.to(device=model.device, dtype=model.dtype),
                    **gen_kwargs,
                )
            # clean_up_tokenization_spaces pinned EXPLICITLY to True: that is
            # the default the verified eval stack (4.48.3) actually measured,
            # and it keeps serving output consistent with the eval pipeline
            # even when a future transformers flips the default to False.
            text = processor.tokenizer.batch_decode(
                ids, skip_special_tokens=True, clean_up_tokenization_spaces=True
            )[0].strip()
            return {
                "text": text,
                "language": "urdu",
                "sample_rate": sample_rate,
                "note": "single-window transcription; long-clip windowing is NOT implemented in this scaffold",
            }
        except ProviderError:
            raise  # controlled errors keep their exact identity/status
        except Exception as err:
            raise InferenceError(
                f"ASR inference failed in this environment: {type(err).__name__}: {err}. "
                "Nothing was silently substituted (no Gemini fallback)."
            ) from err

    def draft(self, transcript: str) -> Dict[str, Any]:
        try:
            state = self._loaded["soap"] or self._load_soap()
            torch = self._real_stack()
            model = state["model"]
            tok = state["tokenizer"]
            # return_dict=True is EXPLICIT: the unpinned Colab resolve revealed
            # that implicit template-return shape drifted across transformers
            # versions (raw Tensor -> BatchEncoding) and crashed the real
            # /draft gate with KeyError('shape'). Explicit + _unwrap_chat_prompt
            # accepts both shapes; the runtime itself is pinned in
            # requirements-serving-ml.txt.
            prompt = tok.apply_chat_template(
                [
                    {"role": "system", "content": self._cfg.soap_system_prompt},
                    {"role": "user", "content": transcript},
                ],
                tokenize=True,
                add_generation_prompt=True,
                return_tensors="pt",
                return_dict=True,
            )
            prompt_ids, prompt_mask = _unwrap_chat_prompt(prompt)
            gen_kwargs: Dict[str, Any] = {
                "input_ids": prompt_ids.to(model.device),
                "max_new_tokens": self._cfg.draft_max_new_tokens,
                "do_sample": False,
                "pad_token_id": tok.pad_token_id or tok.eos_token_id,
            }
            if prompt_mask is not None:
                gen_kwargs["attention_mask"] = prompt_mask.to(model.device)
            with torch.no_grad():
                out = model.generate(**gen_kwargs)
            continuation = out[:, prompt_ids.shape[-1]:]
            # clean_up_tokenization_spaces pinned for the same reason as ASR:
            # frozen to the verified 4.48.3 default the eval pipeline measured.
            text = tok.batch_decode(
                continuation, skip_special_tokens=True, clean_up_tokenization_spaces=True
            )[0].strip()
            return {
                "draft": text,
                "generation": "greedy",
                "max_new_tokens": self._cfg.draft_max_new_tokens,
                "note": "assistive DRAFT - deterministic guard annotations attached; vet confirmation is mandatory",
            }
        except ProviderError:
            raise
        except Exception as err:
            raise InferenceError(
                f"SOAP draft inference failed in this environment: {type(err).__name__}: {err}. "
                "Nothing was silently substituted (no Gemini fallback)."
            ) from err

    def roman(self, text: str) -> Dict[str, Any]:
        try:
            state = self._loaded["roman"] or self._load_roman()
            torch = self._real_stack()
            model = state["model"]
            tok = state["tokenizer"]
            ids = tok(TASK_PREFIX + text, return_tensors="pt", truncation=True, max_length=128)
            with torch.no_grad():
                out = model.generate(
                    input_ids=ids.input_ids.to(model.device),
                    max_new_tokens=self._cfg.roman_max_new_tokens,
                    num_beams=1,
                    do_sample=False,
                )
            roman = tok.batch_decode(
                out, skip_special_tokens=True, clean_up_tokenization_spaces=True
            )[0].strip()
            return {"roman": roman, "task_prefix": TASK_PREFIX}
        except ProviderError:
            raise
        except Exception as err:
            raise InferenceError(
                f"Roman inference failed in this environment: {type(err).__name__}: {err}. "
                "Nothing was silently substituted (no Gemini fallback)."
            ) from err

    # ---------- unload / swap (Windows RAM safeguard) ----------

    def unload(self, key: str) -> bool:
        if key not in self._loaded or self._loaded[key] is None:
            return False
        self._loaded[key] = None
        gc.collect()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass  # no torch in this process - CPU refs are already dropped
        return True


class GeminiProxyProvider:
    """Passthrough to the EXISTING Gemini-backed processing service.

    Used only when a REQUEST explicitly selects provider="gemini" (or the
    configured default is gemini). If VOXSOAP_GEMINI_PROXY_URL is unset the
    provider answers honest 501; it NEVER falls back to or from the ML path.
    """

    name = "gemini"
    is_mock = False

    def __init__(self, cfg: Any):
        self._cfg = cfg

    def _post_task(self, task: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        if not self._cfg.gemini_proxy_url:
            raise NotConfigured(
                "VOXSOAP_GEMINI_PROXY_URL is not set - the Gemini proxy path is not configured. "
                "This is an honest 501 (no silent ML fallback, and the ML path did not fail here)."
            )
        try:
            import httpx
        except Exception as err:
            raise InferenceError(f"httpx is unavailable in this Python environment: {err}") from err
        body = {"task": task, "payload": payload, "client": "voxsoap-ml-serving"}
        try:
            response = httpx.post(self._cfg.gemini_proxy_url, json=body, timeout=120.0)
        except Exception as err:
            raise InferenceError(
                f"Gemini proxy unreachable ({type(err).__name__}): {err}"
            ) from err
        if response.status_code >= 400:
            raise InferenceError(
                f"Gemini proxy returned HTTP {response.status_code}",
                detail={"upstream_status": response.status_code, "upstream_body": response.text[:500]},
            )
        try:
            return response.json()
        except ValueError:
            return {"raw_upstream_body": response.text[:2000]}

    def scale_for(self, key: str) -> Tuple[str, str]:
        return "NOT_APPLICABLE(gemini proxy carries no local voxsoap ml weights)", "provider_type"

    def describe(self) -> Dict[str, Any]:
        return {
            "proxy_url_set": bool(self._cfg.gemini_proxy_url),
            "is_mock": self.is_mock,
        }

    def transcribe(self, samples, sample_rate: int, audio_bytes: Optional[bytes] = None) -> Dict[str, Any]:
        payload = {
            "audio_b64": base64.b64encode(audio_bytes or b"").decode("ascii"),
            "sample_rate": sample_rate,
            "note": "passthrough to the existing Gemini-backed speech service",
        }
        return self._post_task("transcribe", payload)

    def draft(self, transcript: str) -> Dict[str, Any]:
        return self._post_task("draft", {"transcript": transcript})

    def roman(self, text: str) -> Dict[str, Any]:
        return self._post_task("roman", {"text": text})

    def unload(self, key: str) -> bool:
        return False  # the proxy holds no local model state


def deepcopy_unloaded(ml_provider: MLProvider) -> MLProvider:
    """Swap helper: returns a same-config MLProvider with everything unloaded.

    This exists so an operator/logging tool can prove that a cloned container
    holds no loaded weights; the real RAM swap in this scaffold is simply
    POST /unload (+ optionally restarting with new VOXSOAP_*_ADAPTER_DIR env).
    """
    clone = MLProvider(ml_provider._cfg)
    assert clone._loaded == {k: None for k in COMPONENT_KEYS}
    return clone
