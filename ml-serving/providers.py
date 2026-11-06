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
import re
import time
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

# Kept in byte-for-byte sync with train_transliteration_lora.py and
# evaluate_transliteration.py (the EXACT same prefix must be used in serving).
TASK_PREFIX = "transliterate to roman urdu: "

COMPONENT_KEYS = ("asr", "soap", "roman")

# Owner reliability fix (2026-11-04): pre-draft ASR release policy. On CPU
# the fp32 Whisper (~1.2 GB) stays resident while the bf16 3B SOAP model
# generates; on a 16 GB Windows box with Chrome + the dev server running,
# tight RAM pages and long drafts balloon (health checks answer late).
# When free physical RAM is under this threshold BEFORE a draft generation,
# the ASR weights are dropped first (the next /transcribe reloads them on
# demand - one cold Whisper load). Env override honoured (never a silent
# default change); introspection failures never break inference.
try:
    _ASR_RELEASE_FREE_RAM_GB = max(
        0.5, float(_boot_os.environ.get("VOXSOAP_ASR_RELEASE_FREE_RAM_GB", "2.0"))
    )
except ValueError:
    _ASR_RELEASE_FREE_RAM_GB = 2.0

# ---- Vet Scribenote contract (owner Fix 2, 2026-11-01) ----------------------
# The medscribe soap-lora adapter forces SHORT human-medical summaries and
# building a 23-parameter objective by generating "Not mentioned" 21 times
# burns ~150 CPU tokens. The default /draft format ("vet_scribenote")
# therefore runs the BASE Qwen weights (adapter disabled) with a strict
# veterinary prompt: the model only states parameters the transcript
# EXPLICITLY contains, and Python post-processing deterministically hydrates
# all 23 canonical parameters (missing -> "Not mentioned").

VET_NOTE_FORMAT = "vet_scribenote"
VET_NOTE_FORMATS = ("vet_scribenote", "medscribe")

# Canonical physical-exam parameters, EXACT owner order (never re-sorted).
VET_OBJECTIVE_PARAMS: Tuple[str, ...] = (
    "Temperature",
    "Heart Rate",
    "Weight",
    "Respiratory Rate",
    "Capillary Refill Time",
    "Mucous Membranes",
    "Hydration Status",
    "Body Condition Score",
    "Pain Score",
    "Fear Anxiety Stress Score",
    "Eyes",
    "Ears",
    "Nasal",
    "Oral/Dental",
    "Cardiovascular",
    "Respiratory",
    "Neurological",
    "Musculoskeletal",
    "Lymphatic",
    "Gastrointestinal",
    "Reproductive/Urinary",
    "Integument",
    "Masses",
)

VET_NOT_MENTIONED = "Not mentioned"

# Model-emitted non-data placeholders (wrong: line should not exist at all)
# map deterministically onto the canonical "Not mentioned" hydration. A value
# is kept ONLY when it carries actual spoken data — any of these placeholder
# tokens as the WHOLE value means "not documented in the transcript".
_VET_PLACEHOLDER_VALUES = (
    "not examined",
    "not noted",
    "not stated",
    "not documented",
    "not mentioned",
    "not evaluated",
    "not assessed",
    "not performed",
    "not recorded",
    "not checked",
    "unremarkable",
    "unspecified",
    "no abnormality",
    "no abnormality detected",
    "no findings",
    "no data",
    "nad",
    "wnl",
    "n/a",
    "na",
    "none",
    "normal",
    "within normal limits",
)


def _vet_value_or_not_mentioned(value: str) -> str:
    """Deterministic placeholder collapse: a bare non-data token ("Normal",
    "WNL", "not examined", ...) hydrates to "Not mentioned"; a spoken value
    with real content survives verbatim."""
    v = re.sub(r"\s+", " ", value or "").strip()
    if not v:
        return VET_NOT_MENTIONED
    norm = re.sub(r"[^a-z0-9/]", "", v.lower())
    if norm in {re.sub(r"[^a-z0-9/]", "", p) for p in _VET_PLACEHOLDER_VALUES}:
        return VET_NOT_MENTIONED
    return v


# ---- objective-value trace gate (owner no-hallucination doctrine) -----------
# 2026-11-03 live probe: even with the hardened prompt the base-3B model
# states unstated parameters ("Mucous Membranes: pink and moist"). The same
# rule the frontend verifyGroundedClaims (FR-27) enforces applies here:
# UNTRACEABLE claims are DROPPED (never rewritten). A stated objective VALUE
# survives only when EVERY meaningful token has a verbatim trace in the
# consultation transcript (`transcript` is always available in the serving
# path); otherwise it deterministically hydrates to "Not mentioned" and is
# counted for the honesty note. Units and copulas are stopwords (they carry
# no finding; "kg"/"bpm" must not gate a value the transcript phrases as
# "kilograms"). Numbers are kept dotful ("24.5" must match "24.5").
_VET_TRACE_STOPWORDS = frozenset({
    "a", "an", "the", "and", "or", "of", "in", "to", "with", "for", "on",
    "is", "are", "was", "were", "be", "at", "by", "as", "it", "its",
    "no", "not", "very", "both", "s", "kg", "lbs", "bpm", "f", "c", "mm",
})


def _vet_norm_trace(value: str) -> str:
    return re.sub(r"[^a-z0-9.]+", " ", (value or "").lower()).strip()


def _vet_value_traced(value: str, transcript_norm: str) -> bool:
    tokens = [
        token for token in _vet_norm_trace(value).split()
        if token and token not in _VET_TRACE_STOPWORDS
    ]
    if not tokens or not transcript_norm:
        return False
    return all(token in transcript_norm for token in tokens)


VET_SCRIBENOTE_SYSTEM_PROMPT = (
    "You are a veterinary medical scribe. From the consultation transcript, "
    "write a clinical note using EXACTLY these four headings, each on its own "
    "line, in this order:\n"
    "SUBJECTIVE:\n"
    "OBJECTIVE_MENTIONED:\n"
    "ASSESSMENT:\n"
    "PLAN:\n"
    "SUBJECTIVE: one detailed third-person clinical history paragraph "
    "covering the patient's signalment (species, age), the presenting "
    "complaint, its duration, the observed clinical signs, recent "
    "grooming/bathing/exposures, and past medical history with prior "
    "medications.\n"
    "OBJECTIVE_MENTIONED: only the physical-exam or vital parameters the "
    "transcript EXPLICITLY states, one per line as 'Name: value'. Use these "
    "canonical names exactly when stated: Temperature, Heart Rate, Weight, "
    "Respiratory Rate, Capillary Refill Time, Mucous Membranes, Hydration "
    "Status, Body Condition Score, Pain Score, Fear Anxiety Stress Score, "
    "Eyes, Ears, Nasal, Oral/Dental, Cardiovascular, Respiratory, "
    "Neurological, Musculoskeletal, Lymphatic, Gastrointestinal, "
    "Reproductive/Urinary, Integument, Masses. A line may be written ONLY "
    "when the transcript literally provides that value; copy the spoken "
    "value verbatim (never paraphrase or estimate numbers). OMIT every "
    "parameter the transcript does not state, and FORBIDDEN placeholders: "
    "never write 'Not examined', 'Normal', 'WNL', 'N/A', 'unremarkable', "
    "'not noted' or 'unspecified' for an omitted parameter — the line must "
    "not exist at all. NEVER write your own 'Not mentioned'.\n"
    "ASSESSMENT: a bulleted list ('- ') of diagnoses or findings, suspected "
    "causes, and preventative/vaccination status.\n"
    "PLAN: a bulleted list ('- ') of treatments or vaccines administered "
    "today, prescribed medications with exact dose, route, frequency and "
    "duration, and any recheck instructions.\n"
    "Rules: write in the third person; never invent findings or values "
    "absent from the transcript; keep the four headings exactly as written."
)

# Case/punctuation-insensitive matching for model-emitted objective keys.
def _vet_normalize_key(raw: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", raw.strip().lower())


_CANONICAL_KEY_LOOKUP: Dict[str, str] = {
    _vet_normalize_key(name): name for name in VET_OBJECTIVE_PARAMS
}
_CANONICAL_KEY_LOOKUP.update({
    "temp": "Temperature",
    "tempc": "Temperature",
    "hr": "Heart Rate",
    "pulse": "Heart Rate",
    "bw": "Weight",
    "bodyweight": "Weight",
    "rr": "Respiratory Rate",
    "resprate": "Respiratory Rate",
    "crt": "Capillary Refill Time",
    "capillaryrefill": "Capillary Refill Time",
    "mucous": "Mucous Membranes",
    "mm": "Mucous Membranes",
    "hydration": "Hydration Status",
    "bcs": "Body Condition Score",
    "bodycondition": "Body Condition Score",
    "pain": "Pain Score",
    "fas": "Fear Anxiety Stress Score",
    "fearanxietystress": "Fear Anxiety Stress Score",
    "fascore": "Fear Anxiety Stress Score",
    "eye": "Eyes",
    "ocular": "Eyes",
    "ear": "Ears",
    "earcanal": "Ears",
    "otoscopy": "Ears",
    "otoscopic": "Ears",
    "nose": "Nasal",
    "nasalcavity": "Nasal",
    "oral": "Oral/Dental",
    "dental": "Oral/Dental",
    "mouth": "Oral/Dental",
    "heart": "Cardiovascular",
    "cv": "Cardiovascular",
    "lung": "Respiratory",
    "lungs": "Respiratory",
    "chest": "Respiratory",
    "auscultation": "Cardiovascular",
    "neuro": "Neurological",
    "msk": "Musculoskeletal",
    "lymphnode": "Lymphatic",
    "lymphnodes": "Lymphatic",
    "gi": "Gastrointestinal",
    "abdomen": "Gastrointestinal",
    "abdominal": "Gastrointestinal",
    "reproductive": "Reproductive/Urinary",
    "urinary": "Reproductive/Urinary",
    "urogenital": "Reproductive/Urinary",
    "skin": "Integument",
    "coat": "Integument",
    "mass": "Masses",
    "lesion": "Masses",
    "lesions": "Masses",
})

_VET_HEADER_NAMES = {
    "subjective": "subjective",
    "objectivementioned": "objective",
    "objective": "objective",
    "assessment": "assessment",
    "plan": "plan",
}


def _vet_split_sections(raw: str) -> Dict[str, str]:
    """Split model output into {subjective, objective, assessment, plan}.

    Deterministic: matches the four mandated headings case-insensitively,
    tolerating a missing colon and in-line content on the heading line. If a
    continuation line without a colon appears inside OBJECTIVE... it is kept
    for the key/value parser. When NO heading is matched at all, the whole
    raw text is retained as the subjective fallback (nothing is discarded).
    """
    buckets: Dict[str, list] = {"subjective": [], "objective": [], "assessment": [], "plan": []}
    current: Optional[str] = None
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        head, sep, rest = stripped.partition(":")
        bucket = _VET_HEADER_NAMES.get(_vet_normalize_key(head))
        # A header colon (or a bare heading word) switches sections; a value
        # line such as "Temperature: 102.5" normalizes to "temperature" which
        # is NOT in the header set, so it cannot be confused with a heading.
        if bucket and (sep == ":" or not rest):
            current = bucket
            if rest.strip():
                buckets[current].append(rest.strip())
            continue
        if current is not None:
            buckets[current].append(stripped)
        # Pre-heading preamble is dropped (title noise like "SOAP Note:").
    found = any(buckets.values())
    if not found:
        buckets["subjective"] = [raw.strip()]
    return {key: "\n".join(lines).strip() for key, lines in buckets.items()}


def _vet_parse_objective(lines_text: str) -> Tuple[Dict[str, str], int]:
    """Parse OBJECTIVE(_MENTIONED) lines into canonical-keyed values.

    Returns (values, unknown_count). `key: value` splits on the first colon
    (falling back to ' - '), canonical names/aliases are matched
    case/punctuation-insensitively, and colon-less continuation lines are
    appended to the PREVIOUS key's value (multi-line exam findings survive).
    Unknown keys are counted, never silently accepted into the shape.
    """
    values: Dict[str, str] = {}
    unknown = 0
    current: Optional[str] = None
    for line in lines_text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        head, sep, value = stripped.partition(":")
        if sep != ":":
            head, sep, value = stripped.partition(" - ")
        canonical = _CANONICAL_KEY_LOOKUP.get(_vet_normalize_key(head)) if sep else None
        if canonical:
            val = value.strip()
            while val.startswith("-"):
                val = val[1:].lstrip()
            values[canonical] = val
            current = canonical
        elif current:
            # Continuation of the previous finding (no key on this line).
            values[current] = f"{values[current]} {stripped}".strip()
        else:
            unknown += 1
    return values, unknown


def _vet_normalize_bullets(text: str) -> str:
    """Every non-empty line becomes a '- ' bullet (deterministic shape)."""
    bullets = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        bullets.append(stripped if stripped.startswith("-") else f"- {stripped}")
    return "\n".join(bullets)


def _vet_hydrated_story(
    raw_text: str, transcript: Optional[str] = None
) -> Tuple[str, Dict[str, str], int, int]:
    """Build the hydrated (draft_text, sections, unknown, drops) tuple.

    `transcript` (the ORIGINAL consultation transcript, available in the
    serving draft path) enables the deterministic value-trace gate: a stated
    value with no verbatim token trace in the transcript is dropped to
    "Not mentioned" (counted in `drops`). Passing None keeps the gate inert
    for pure unit calls — the placeholder collapse still applies.
    """
    buckets = _vet_split_sections(raw_text)
    objective_values, unknown = _vet_parse_objective(buckets["objective"])
    # Deterministic hydration: missing -> "Not mentioned" AND a bare model
    # placeholder ("Normal", "WNL", "not examined", ...) ALSO collapses to
    # "Not mentioned" — the canonical fill is the ONLY "not documented"
    # representation in the note, so the Andre-VetNote renderer and the
    # frontend null-mapping never see a fake data value. The trace gate then
    # drops model-invented VALUES (e.g. "pink and moist" vitals) that have no
    # verbatim trace in the consultation transcript — mirrored from the
    # frontend FR-27 rule (untraceable claims are dropped, never rewritten).
    transcript_norm = _vet_norm_trace(transcript) if transcript else ""
    objective_map: Dict[str, str] = {}
    drops = 0
    for name in VET_OBJECTIVE_PARAMS:
        value = _vet_value_or_not_mentioned(objective_values.get(name) or "")
        if transcript and value != VET_NOT_MENTIONED and not _vet_value_traced(value, transcript_norm):
            value = VET_NOT_MENTIONED
            drops += 1
        objective_map[name] = value
    objective_text = "\n".join(f"{name}: {value}" for name, value in objective_map.items())
    sections: Dict[str, str] = {
        "subjective": buckets["subjective"],
        "objective_map": objective_map,
        "objective_text": objective_text,
        "assessment": _vet_normalize_bullets(buckets["assessment"]),
        "plan": _vet_normalize_bullets(buckets["plan"]),
    }
    draft_text = (
        "SUBJECTIVE:\n"
        f"{sections['subjective']}\n\n"
        "OBJECTIVE_MENTIONED:\n"
        f"{objective_text}\n\n"
        "ASSESSMENT:\n"
        f"{sections['assessment']}\n\n"
        "PLAN:\n"
        f"{sections['plan']}"
    )
    return draft_text, sections, unknown, drops


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
        # The Whisper checkpoint ships a STALE generation_config default
        # (forced_decoder_ids = [[1, None], [2, 50359]]). transformers 4.48
        # IGNORES it whenever task/language kwargs are passed (the live server
        # log proved exactly that conflict warning) - our generate recipe
        # (evaluate_asr.py: max_new_tokens + language + task) is kwarg-driven.
        # Clearing the stale default here is therefore a NO-OP for behaviour;
        # it only removes the false-conflict warning noise at generate time.
        stale_forced_ids = getattr(base, "generation_config", None)
        if stale_forced_ids is not None and getattr(stale_forced_ids, "forced_decoder_ids", None):
            stale_forced_ids.forced_decoder_ids = None
        model = PeftModel.from_pretrained(base, str(comp["adapter_dir"]))
        model.to(device)
        model.eval()
        if device == "cpu":
            # Owner Fix 1 (2026-11-01): saturate every physical core - the
            # default intra-op pool leaves half the machine idle on Whisper
            # decode. torch.set_num_threads is PROCESS-GLOBAL and sticky: the
            # draft path deliberately re-bounds it lower (loop headroom, see
            # draft()), so transcribe() re-applies this Fix-1 saturation
            # defensively on every call (the comment previously promised that
            # re-apply and it was missing).
            threads = _boot_os.cpu_count() or 1
            torch.set_num_threads(threads)
            if _boot_os.environ.get("VOXSOAP_ASR_QUANT", "").strip() == "1":
                # Optional fast path, DEFAULT OFF: dynamic qint8 quantization
                # rewrites EVERY Linear in place - including the PEFT
                # lora_A/lora_B projections - which is an unverified
                # eval-parity + adapter-interaction risk. Explicit opt-in
                # knob (VOXSOAP_ASR_QUANT=1), never a silent default; torch
                # set_num_threads already delivers a large CPU win.
                from torch.ao.quantization import quantize_dynamic

                model = quantize_dynamic(model, {torch.nn.Linear}, dtype=torch.qint8)
        state = {"model": model, "processor": processor, "device": device, "loaded_at": time.time()}
        self._loaded["asr"] = state
        return state

    def _load_soap(self) -> Dict[str, Any]:
        comp = self._require_adapter("soap")
        torch = self._real_stack()
        from peft import PeftModel
        from transformers import AutoModelForCausalLM, AutoTokenizer

        device = self._resolve_device()
        # 2026-10-31 local-speed fix: the fp32 3B CPU load is ~12.4 GB against
        # a 15.9 GB machine (disk-swap city). PyTorch CPU supports bfloat16
        # natively on x86_64 (oneDNN): bf16 weights are ~6.2 GB AND matmuls
        # run FASTER than fp32 on this stack. fp16 remains the CUDA choice;
        # VOXSOAP_SOAP_DTYPE=bfloat16|float16|float32 is the honest override.
        # (mt5/roman keeps its fp32 master - its direct-fp16 NaN guard note
        # above does not apply here: Qwen is a causal LM, not a T5 family.)
        dtype_env = str(getattr(self._cfg, "soap_dtype", "auto") or "auto").strip().lower()
        if dtype_env in ("bfloat16", "bf16"):
            dtype = torch.bfloat16
        elif dtype_env == "float16":
            dtype = torch.float16
        elif dtype_env == "float32":
            dtype = torch.float32
        else:  # auto
            dtype = torch.float16 if device == "cuda" else torch.bfloat16
        tokenizer_src = str(comp["adapter_dir"])
        try:
            tok = AutoTokenizer.from_pretrained(tokenizer_src)
        except Exception:
            # Same checkpoint family only: the adapter's manifest base id and
            # revision were ALREADY validated against the configured base in
            # _require_adapter(), so falling back to that validated base's
            # tokenizer is safe (never a silent cross-model mix).
            tok = AutoTokenizer.from_pretrained(comp["base_model"], revision=comp["base_revision"])
        load_kwargs = _prep_dtype_kwargs(dtype)
        if device == "cpu":
            # accelerate-backed lazy load: builds the fp/bf16 skeleton then
            # streams weights in, avoiding a transient fp32 copy of the base.
            load_kwargs["low_cpu_mem_usage"] = True
        base = AutoModelForCausalLM.from_pretrained(
            comp["base_model"], revision=comp["base_revision"], **load_kwargs
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

    def _free_ram_gb(self) -> Optional[float]:
        """Best-effort free-physical-RAM probe with NO new dependency (the
        pinned stack stays untouched): Win32 GlobalMemoryStatusEx via ctypes,
        /proc/meminfo MemAvailable on POSIX. Returns None when unanswerable -
        introspection must NEVER break inference."""
        try:
            if _boot_os.name == "nt":
                import ctypes

                class _MemoryStatusEx(ctypes.Structure):
                    _fields_ = [
                        ("dwLength", ctypes.c_ulong),
                        ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong),
                        ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong),
                        ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong),
                        ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                    ]

                stat = _MemoryStatusEx()
                stat.dwLength = ctypes.sizeof(_MemoryStatusEx)
                if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
                    return stat.ullAvailPhys / (1024.0 ** 3)
                return None
            with open("/proc/meminfo", "r", encoding="utf-8") as fh:
                for line_ in fh:
                    if line_.startswith("MemAvailable:"):
                        return float(line_.split()[1]) / (1024.0 * 1024.0)
        except Exception:
            return None
        return None

    def _maybe_release_asr_for_draft(self) -> None:
        """Owner reliability fix (2026-11-04): on CPU the fp32 Whisper stays
        resident (~1.2 GB) while the bf16 3B SOAP model generates; on the 16 GB
        Windows owner box (Chrome + Next dev server running) tight RAM pages
        and health answers get late. When free physical RAM is under the
        threshold, drop the ASR weights BEFORE generation; the next
        /transcribe reloads them on demand (one cold Whisper load). Threshold:
        VOXSOAP_ASR_RELEASE_FREE_RAM_GB (default 2.0)."""
        if not self._loaded.get("asr"):
            return
        free_gb = self._free_ram_gb()
        if free_gb is None or free_gb >= _ASR_RELEASE_FREE_RAM_GB:
            return
        try:
            self.unload("asr")
            free_after = self._free_ram_gb()
            after_label = (
                "?" if free_after is None else f"{free_after:.1f} GB"
            )
            print(
                "[voxsoap-ml] ASR released before draft generation to free RAM "
                f"(free={free_gb:.1f} GB < {_ASR_RELEASE_FREE_RAM_GB:.1f} GB threshold; "
                f"free_after={after_label}; the next /transcribe reloads Whisper on demand).",
                flush=True,
            )
        except Exception as cleanup_err:  # never let the sweep break the draft
            print(
                f"[voxsoap-ml] ASR pre-draft release skipped "
                f"({type(cleanup_err).__name__}: {cleanup_err}).",
                flush=True,
            )

    def transcribe(self, samples, sample_rate: int, audio_bytes: Optional[bytes] = None,
                   language: str = "ur") -> Dict[str, Any]:
        try:
            state = self._loaded["asr"] or self._load_asr()
            torch = self._real_stack()
            import numpy as np

            model = state["model"]
            processor = state["processor"]
            # Owner Fix 1 contract (the comment promised this per-call
            # re-apply and it was missing): torch.set_num_threads is
            # process-global and STICKY - after draft() bounded it to keep
            # loop headroom, every transcribe re-applies the Fix-1 saturation
            # (never shrinks: an explicit VOXSOAP_DRAFT_THREADS setting stays
            # a draft-only cap; Fix-1 saturation treats WHISPER decode only).
            if state.get("device") == "cpu":
                saturate = _boot_os.cpu_count() or 1
                if torch.get_num_threads() < saturate:
                    torch.set_num_threads(saturate)
            speech = np.asarray(samples, dtype=np.float32)

            # Language contract for /transcribe: explicit "ur"/"en" tag the
            # decoder with the SAME recipe the verified eval pipeline used
            # (language + task kwargs); "auto" omits the language kwarg so
            # Whisper detects language from the audio. Values are validated in
            # the API layer; the default stays "ur" (the original scaffold
            # behaviour - no silent contract change for existing callers).
            lang_key = (language or "ur").strip().lower()
            lang_whisper = {"ur": "urdu", "en": "english"}.get(lang_key)
            # Owner Fix 1 (2026-11-01, FLEURS early-cutoff): the ur-LoRA
            # adapter was trained on FLEURS clips - single 5-8 s sentences
            # padded to 30 s - so on DENSE continuous English dialogue it
            # prematurely emits </s> after 1-2 sentences. English therefore
            # decodes with the UNCORRUPTED base openai/whisper-small weights
            # (adapter disabled); Urdu keeps the adapter; "auto" also keeps
            # it (documented: explicit 'en' is the English escape hatch).
            use_base_weights = lang_key == "en"

            def _decode_window(window: "np.ndarray") -> str:
                feats = processor.feature_extractor(
                    window,
                    sampling_rate=sample_rate,
                    return_attention_mask=True,
                    return_tensors="pt",
                )
                # max_new_tokens is the actively supported generate arg (the
                # exact recipe evaluate_asr.py used for the verified Stage-10
                # eval under the pinned stack); `max_length` is the deprecated
                # Whisper path. condition_on_prev_tokens=False is Fix 1: no
                # cross-chunk conditioning, so a pause or greeting can never
                # gate the rest of the note.
                gen_kwargs: Dict[str, Any] = {
                    "max_new_tokens": self._cfg.asr_max_new_tokens,
                    "task": "transcribe",
                    "condition_on_prev_tokens": False,
                }
                if lang_whisper is not None:
                    gen_kwargs["language"] = lang_whisper
                if getattr(feats, "attention_mask", None) is not None:
                    gen_kwargs["attention_mask"] = feats.attention_mask.to(model.device)
                with torch.no_grad():
                    if use_base_weights:
                        with model.disable_adapter():
                            ids = model.generate(
                                input_features=feats.input_features.to(
                                    device=model.device, dtype=model.dtype
                                ),
                                **gen_kwargs,
                            )
                    else:
                        ids = model.generate(
                            input_features=feats.input_features.to(
                                device=model.device, dtype=model.dtype
                            ),
                            **gen_kwargs,
                        )
                # clean_up_tokenization_spaces pinned EXPLICITLY to True: that
                # is the default the verified eval stack (4.48.3) measured,
                # and it keeps serving output consistent with the eval
                # pipeline even when a future transformers flips the default.
                decoded_text = processor.tokenizer.batch_decode(
                    ids, skip_special_tokens=True, clean_up_tokenization_spaces=True
                )[0].strip()
                # Owner reliability fix (2026-11-04): release the feature and
                # token tensors explicitly before returning so a long
                # multi-chunk consultation keeps a flat GPU/CPU memory profile.
                del feats, ids
                return decoded_text

            # Owner Fix 1: 20 s chunks (320,000 samples at 16 kHz) replace the
            # 30 s split - shorter chunks keep each decode inside the FLEURS
            # distribution the base model handles cleanly.
            chunk_len = 20 * int(sample_rate)
            chunks = [
                (start, min(start + chunk_len, speech.shape[0]))
                for start in range(0, speech.shape[0], chunk_len)
            ]
            chunk_count = len(chunks)
            decoded = []
            skipped_silent = 0
            # Owner reliability fix (2026-11-04): a long consultation is N
            # sequential 20 s decodes on ONE uvicorn worker — a per-chunk
            # failure must surface as a CONTROLLED error naming the chunk
            # (honest 503 JSON envelope via app.py's exception mapping), never
            # an uncaught worker crash; and every finished decode releases its
            # audio/feature tensors on CPU so a 13-minute upload cannot creep
            # the resident set into an OOM kill.
            is_cpu = state.get("device") == "cpu"
            for start, end in chunks:
                chunk = speech[start:end]
                # Silence gate: pure padding/room-tone chunks cost a full
                # decode for nothing - skip them and say so in the note.
                try:
                    is_silent = chunk.shape[0] == 0 or float(np.max(np.abs(chunk))) < 1e-3
                except Exception:
                    is_silent = False  # never let cleanup arithmetic break inference
                if is_silent:
                    skipped_silent += 1
                    del chunk
                    if is_cpu:
                        gc.collect()
                    continue
                try:
                    part_text = _decode_window(chunk)
                except ProviderError:
                    raise  # controlled errors keep their identity/status
                except Exception as chunk_err:
                    raise InferenceError(
                        f"Whisper decode failed on chunk [{start}:{end}] "
                        f"({chunk.shape[0]} samples, "
                        f"chunk {len(decoded) + skipped_silent + 1}/{chunk_count}): "
                        f"{type(chunk_err).__name__}: {chunk_err}. Controlled error — "
                        "no silent substitution (no Gemini fallback)."
                    ) from chunk_err
                if part_text:
                    decoded.append(part_text)
                # Eager release of THIS chunk's audio reference + a young-gen
                # sweep on CPU: flat resident memory across long consults.
                del chunk
                if is_cpu:
                    gc.collect()
            text = " ".join(decoded)
            if chunk_count == 0:
                note = "empty input audio"
            elif chunk_count == 1:
                note = "single-chunk transcription (input <= 20 s)"
            else:
                note = (
                    f"multi-chunk transcription: {chunk_count} x 20 s chunks joined (no "
                    f"overlap; {skipped_silent} silent chunk(s) skipped); a word straddling "
                    "a chunk boundary may clip"
                )
            return {
                "text": text,
                "language": lang_key,
                "sample_rate": sample_rate,
                "windows": chunk_count,
                "note": note,
            }
        except ProviderError:
            raise  # controlled errors keep their exact identity/status
        except Exception as err:
            raise InferenceError(
                f"ASR inference failed in this environment: {type(err).__name__}: {err}. "
                "Nothing was silently substituted (no Gemini fallback)."
            ) from err

    def draft(self, transcript: str, max_new_tokens: Optional[int] = None,
              note_format: str = VET_NOTE_FORMAT) -> Dict[str, Any]:
        try:
            if (note_format or "").strip().lower() not in VET_NOTE_FORMATS:
                raise InferenceError(
                    f"unsupported draft format {note_format!r}; allowed: "
                    "vet_scribenote | medscribe."
                )
            fmt = (note_format or "").strip().lower()
            state = self._loaded["soap"] or self._load_soap()
            torch = self._real_stack()
            model = state["model"]
            tok = state["tokenizer"]
            is_cpu = state.get("device") == "cpu"
            if is_cpu:
                # Owner reliability fix (2026-11-04): a young-generation sweep
                # before the minutes-long generation, and - when free physical
                # RAM is under the threshold - the resident ASR Whisper is
                # dropped FIRST so a 16 GB Windows box never slips into paging
                # during the draft (health keeps answering; the next
                # /transcribe reloads Whisper on demand).
                self._maybe_release_asr_for_draft()
                gc.collect()
            # return_dict=True is EXPLICIT: the unpinned Colab resolve revealed
            # that implicit template-return shape drifted across transformers
            # versions (raw Tensor -> BatchEncoding) and crashed the real
            # /draft gate with KeyError('shape'). Explicit + _unwrap_chat_prompt
            # accepts both shapes; the runtime itself is pinned in
            # requirements-serving-ml.txt.
            # Owner Fix 2 (2026-11-01): "vet_scribenote" DEFAULT runs the BASE
            # Qwen weights (model.disable_adapter()) - the medscribe soap-lora
            # adapter forces short human-medical summaries and cannot emit the
            # 23-parameter veterinary shape. "medscribe" keeps the EXACT
            # legacy behaviour (adapter enabled + configured system prompt).
            system_prompt = (
                self._cfg.soap_system_prompt if fmt == "medscribe" else VET_SCRIBENOTE_SYSTEM_PROMPT
            )
            prompt = tok.apply_chat_template(
                [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": transcript},
                ],
                tokenize=True,
                add_generation_prompt=True,
                return_tensors="pt",
                return_dict=True,
            )
            prompt_ids, prompt_mask = _unwrap_chat_prompt(prompt)
            # 2026-10-31 local-speed: an explicit request-level cap wins
            # (validated 1..cfg cap at the API layer and echoed in the
            # envelope). None -> a fast CPU default; CUDA keeps the configured
            # 512 (the phase-3 anti-truncation value). Honest, explicit, and
            # visible in the response — never a silent edit of the note.
            # Owner Fix 2: the vet_scribenote shape needs the 23-line hydrated
            # objective TWICE the sketch budget - the CPU default is raised
            # 256 -> 448 (still far below the 512 configured cap), echoed here
            # and in the envelope. The medscribe legacy path keeps 256.
            tokens_cap = self._cfg.draft_max_new_tokens
            if max_new_tokens is not None:
                tokens_cap = int(max_new_tokens)
            elif is_cpu:
                tokens_cap = min(448 if fmt == "vet_scribenote" else 256, tokens_cap)
            gen_kwargs: Dict[str, Any] = {
                "input_ids": prompt_ids.to(model.device),
                "max_new_tokens": tokens_cap,
                "do_sample": False,
                "pad_token_id": tok.pad_token_id or tok.eos_token_id,
            }
            if prompt_mask is not None:
                gen_kwargs["attention_mask"] = prompt_mask.to(model.device)
            if is_cpu:
                # Owner reliability fix (2026-11-04): bound the intra-op pool
                # for the LONG DRAFT so headroom stays for the uvicorn loop
                # (on the 16 GB owner box a fully saturated pool made
                # /health answers late enough to trip the engine's 2 s
                # pre-check). Fix-1 ASR saturation is untouched - the next
                # /transcribe re-applies it defensively. Env override:
                # VOXSOAP_DRAFT_THREADS. Never UP-sizes: an explicitly lower
                # pool stays lower.
                cap_env = _boot_os.environ.get("VOXSOAP_DRAFT_THREADS", "").strip()
                draft_threads = (
                    max(1, int(cap_env))
                    if cap_env.isdigit()
                    else max(2, (_boot_os.cpu_count() or 2) - 2)
                )
                if torch.get_num_threads() > draft_threads:
                    torch.set_num_threads(draft_threads)
            with torch.no_grad():
                if fmt == "vet_scribenote":
                    with model.disable_adapter():
                        out = model.generate(**gen_kwargs)
                else:
                    out = model.generate(**gen_kwargs)
            continuation = out[:, prompt_ids.shape[-1]:]
            # clean_up_tokenization_spaces pinned for the same reason as ASR:
            # frozen to the verified 4.48.3 default the eval pipeline measured.
            text = tok.batch_decode(
                continuation, skip_special_tokens=True, clean_up_tokenization_spaces=True
            )[0].strip()
            if fmt == "medscribe":
                return {
                    "draft": text,
                    "generation": "greedy",
                    "max_new_tokens": tokens_cap,
                    "note": "assistive DRAFT - deterministic guard annotations attached; vet confirmation is mandatory",
                }
            # Owner Fix 2 post-processing: deterministically hydrate ALL 23
            # canonical objective parameters (missing -> "Not mentioned") and
            # ship both the formatted draft string and the structured sections
            # object the frontend maps into the main SOAP workspace cards.
            draft_text, sections, unknown_dropped, trace_dropped = _vet_hydrated_story(text, transcript=transcript)
            note = (
                "assistive DRAFT - deterministic guard annotations attached; "
                "vet confirmation is mandatory"
            )
            if unknown_dropped:
                note += (
                    f" ({unknown_dropped} unrecognized objective line(s) dropped by "
                    "canonical-key matching)"
                )
            if trace_dropped:
                note += (
                    f" ({trace_dropped} objective value(s) dropped: no verbatim trace "
                    "in the consultation transcript - untraceable claims are never "
                    "invented into the note)"
                )
            return {
                "draft": draft_text,
                "sections": sections,
                "format": VET_NOTE_FORMAT,
                "generation": "greedy",
                "max_new_tokens": tokens_cap,
                "note": note,
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

    def transcribe(self, samples, sample_rate: int, audio_bytes: Optional[bytes] = None,
                   language: str = "ur") -> Dict[str, Any]:
        payload = {
            "audio_b64": base64.b64encode(audio_bytes or b"").decode("ascii"),
            "sample_rate": sample_rate,
            "language": (language or "ur"),
            "note": "passthrough to the existing Gemini-backed speech service",
        }
        return self._post_task("transcribe", payload)

    def draft(self, transcript: str, max_new_tokens: Optional[int] = None,
              note_format: str = "vet_scribenote") -> Dict[str, Any]:
        payload: Dict[str, Any] = {"transcript": transcript}
        if max_new_tokens is not None:
            payload["max_new_tokens"] = max_new_tokens
        if note_format:
            payload["format"] = note_format
        return self._post_task("draft", payload)

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
