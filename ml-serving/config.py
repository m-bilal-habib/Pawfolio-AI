"""VoxSOAP ML serving configuration (Phase 4 scaffold - contract §9 region).

Every knob is environment-driven with a VOXSOAP_ prefix so the app can be
retargeted without code edits. Defaults point at the verified FULL-SCALE
Phase-3 export (run 20261030-165202) under ml-training/artifacts/ -
development/gate use ONLY, never a production claim.

Provider rule (contract): the default provider on the ML feature branch must
be explicit, and there is NO hidden fallback that silently switches to Gemini
when an ML call fails. ML failures are surfaced as controlled 5xx errors.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parents[1]

# ACTIVE default: the verified FULL-SCALE Phase-3 gate export (RUN_ID
# 20261030-165202, unpacked + verified 2026-10-30). Both training manifests
# carry model_scale="full", executed=true, Tesla T4 (torch 2.11.0+cu130).
# ASR + SOAP defaults point here. Earlier default exports (run-8 smoke
# 20261027-181112 and run-9 20261028-142956) no longer exist on disk - the
# 20261030 combined archive REPLACED them as the serving source. SHA-256 of
# the export + both adapter weights are recorded in
# ml-training/reports/phase3_gate_report.md.
# Model C (Roman Urdu transliteration) is DEPRECATED (2026-10-29, runs 9/10/11):
# every training recipe failed its evaluation - run-9 emitted ONLY the mT5
# span-corruption sentinel '<extra_id_0>' (CER 0.9142), run-10 plateaued at
# loss ~= ln(vocab) (CER 6.1456), run-11 degenerated into repetition loops
# (CER 6.8905, exact_match 0.0). The roman default therefore stays None and
# /roman answers an honest 501; VOXSOAP_ROMAN_ADAPTER_DIR remains a
# diagnostics-only override for a supervised owner-approved re-enable.
_FULLSCALE_ARTIFACTS = (
    REPO_ROOT / "ml-training" / "artifacts" / "unpacked_voxsoap_ml_exports_20261030-165202"
)

VALID_PROVIDERS = ("ml", "gemini")

# Byte-for-byte copies of train_soap_lora.py's SYSTEM_PROMPT (serving MUST
# prompt the fine-tuned model the same way it was trained).
DEFAULT_SOAP_SYSTEM_PROMPT = (
    "You draft a structured SOAP note (Subjective, Objective, Assessment, Plan) "
    "strictly from the supplied consultation text. Never invent vitals, exam "
    "findings, medications, or doses that are not stated. If information is "
    "missing, leave the section short ('not stated') instead of filling it."
)


@dataclass(frozen=True)
class ServingConfig:
    default_provider: str = "ml"  # contract: the default must be explicit
    # ASR component: adapter is NOT a complete model; base id+revision must
    # match the adapter's training_manifest.json exactly (validated at load).
    asr_base_model: str = "openai/whisper-small"
    asr_base_revision: str = "main"
    asr_adapter_dir: Optional[Path] = _FULLSCALE_ARTIFACTS / "asr" / "whisper-lora-ur-20261030-165202"
    # SOAP component.
    soap_base_model: str = "Qwen/Qwen2.5-3B-Instruct"
    soap_base_revision: str = "main"
    soap_adapter_dir: Optional[Path] = _FULLSCALE_ARTIFACTS / "soap" / "soap-lora-20261030-165202"
    soap_system_prompt: str = DEFAULT_SOAP_SYSTEM_PROMPT
    # Roman Urdu (Model C): DEPRECATED (2026-10-29, runs 9/10/11 eval failed)
    # -> /roman stays an honest 501; only a supervised owner-approved adapter
    # with a PASSING eval changes this. VOXSOAP_ROMAN_ADAPTER_DIR = diagnostics.
    roman_base_model: str = "google/mt5-small"
    roman_base_revision: str = "main"
    roman_adapter_dir: Optional[Path] = None
    # Gemini path: proxy passthrough (the EXISTING Gemini-backed service).
    gemini_proxy_url: Optional[str] = None  # unset -> provider=gemini is honest 501
    # Server binding - contract: Next.js calls http://127.0.0.1:<port>.
    host: str = "127.0.0.1"
    port: int = 8321
    # Real inference runtime. Windows RAM safeguard note: 4-bit bitsandbytes
    # does NOT work on Windows (Linux-only), so the SOAP base loads in plain
    # dtype (~6-12 GB RAM). Load is lazy (first request) and /unload frees it.
    device: str = "auto"  # "auto" | "cpu" | "cuda"
    target_sample_rate: int = 16000  # honest 400 on any other rate; no silent resample
    max_audio_mb: float = 25.0
    transcript_max_chars: int = 14000  # prepare_soap_data.py MAX_CHARS cap
    asr_max_new_tokens: int = 256      # evaluate_asr.py generate recipe
    draft_max_new_tokens: int = 512    # GGUF CPU fast path (2026-11-20): at ~4.8 tok/s
    # 512 tokens finishes in ~1.8 min and prevents truncating ASSESSMENT/PLAN on
    # dense 5-minute consultations (the old 320 cap was a bf16-torch workaround).
    # SOAP base dtype: "auto" = fp16 on CUDA, bfloat16 on CPU (2026-10-31
    # local-speed fix: bf16 halves the 3B CPU RAM footprint ~12.4 -> ~6.2 GB
    # and is FASTER on x86_64/oneDNN). Override honestly:
    # VOXSOAP_SOAP_DTYPE=bfloat16|float16|float32.
    soap_dtype: str = "auto"
    # ---- Fast CPU draft backend (owner fix 2026-11-19) ---------------------
    # The owner i5-6300U (Skylake 2C/4T, no native BF16, no GPU) pages its
    # 16 GB RAM under Chrome + Next dev, stretching a 320-token bf16 draft to
    # ~950-1,530 s. The vet_scribenote path ALREADY runs the base weights
    # (disable_adapter), so a quantized GGUF of the same Qwen2.5-Instruct
    # family gives the SAME clinical grounding in ~2.1 GB with llama.cpp AVX2
    # decode. "auto" = gguf on CPU for vet_scribenote when llama_cpp imports;
    # CUDA and the legacy "medscribe" PEFT path stay torch. Backend choice is
    # always echoed honestly in the draft envelope (backend/gguf_model).
    soap_backend: str = "auto"  # "auto" | "gguf" | "torch"
    soap_gguf_repo: str = "Qwen/Qwen2.5-1.5B-Instruct-GGUF"
    soap_gguf_file: str = "qwen2.5-1.5b-instruct-q4_k_m.gguf"
    # Explicit local .gguf path (skips the HF-cache download entirely).
    soap_gguf_path: Optional[Path] = None
    # KV-cache window: system prompt + a 5-min consult (~1k tokens) + output.
    soap_n_ctx: int = 4096
    # 0 -> resolved in providers.py as max(2, cpu_count-1). On the 2C/4T
    # owner box benchmark 2-3 threads beats 4 (Hyper-Threading contention).
    soap_n_threads: int = 0
    # llama.cpp batch sizes (2026-11-20 RSS gate). The vocabulary is 151,936
    # tokens: at the llama.cpp default n_batch=512 the output/logits buffers
    # alone cost ~311 MB, pushing the measured peak working set to ~3.44 GB.
    # n_batch=128/n_ubatch=128 shrinks those buffers while still ingesting the
    # ~1.4k-token prompt in a few passes.
    soap_n_batch: int = 128
    soap_n_ubatch: int = 128
    roman_max_new_tokens: int = 256    # evaluate_transliteration.py recipe


def _env_path(name: str) -> Optional[Path]:
    raw = os.getenv(name, "").strip()
    return Path(raw).expanduser() if raw else None


def _env_str(name: str, default: str) -> str:
    raw = os.getenv(name, "").strip()
    return raw or default


def _env_optional_str(name: str) -> Optional[str]:
    raw = os.getenv(name, "").strip()
    return raw or None


def load_config() -> ServingConfig:
    provider = _env_str("VOXSOAP_DEFAULT_PROVIDER", "ml").lower()
    if provider not in VALID_PROVIDERS:
        raise ValueError(
            f"VOXSOAP_DEFAULT_PROVIDER={provider!r} is invalid; allowed values: {', '.join(VALID_PROVIDERS)}. "
            "The default provider must be explicit - hidden fallbacks are forbidden."
        )
    soap_backend = _env_str("VOXSOAP_SOAP_BACKEND", "auto").strip().lower()
    if soap_backend not in ("auto", "gguf", "torch"):
        raise ValueError(
            f"VOXSOAP_SOAP_BACKEND={soap_backend!r} is invalid; allowed values: auto, gguf, torch."
        )
    try:
        soap_n_ctx = int(_env_str("VOXSOAP_SOAP_N_CTX", "4096"))
    except ValueError as err:
        raise ValueError("VOXSOAP_SOAP_N_CTX must be an integer (KV-cache window, default 4096).") from err
    if soap_n_ctx < 512:
        raise ValueError(f"VOXSOAP_SOAP_N_CTX={soap_n_ctx} is too small; the scribenote prompt needs >= 512.")
    try:
        soap_n_threads = int(_env_str("VOXSOAP_SOAP_N_THREADS", "0"))
    except ValueError as err:
        raise ValueError("VOXSOAP_SOAP_N_THREADS must be an integer (0 = auto).") from err
    try:
        soap_n_batch = int(_env_str("VOXSOAP_SOAP_N_BATCH", "128"))
        soap_n_ubatch = int(_env_str("VOXSOAP_SOAP_N_UBATCH", "128"))
    except ValueError as err:
        raise ValueError(
            "VOXSOAP_SOAP_N_BATCH / VOXSOAP_SOAP_N_UBATCH must be integers."
        ) from err
    if soap_n_batch < 1 or soap_n_ubatch < 1:
        raise ValueError("VOXSOAP_SOAP_N_BATCH / VOXSOAP_SOAP_N_UBATCH must be >= 1.")
    if soap_n_ubatch > soap_n_batch:
        raise ValueError(
            f"VOXSOAP_SOAP_N_UBATCH={soap_n_ubatch} must be <= "
            f"VOXSOAP_SOAP_N_BATCH={soap_n_batch} (llama.cpp contract)."
        )
    return ServingConfig(
        default_provider=provider,
        asr_base_model=_env_str("VOXSOAP_ASR_BASE_MODEL", "openai/whisper-small"),
        asr_base_revision=_env_str("VOXSOAP_ASR_BASE_REVISION", "main"),
        asr_adapter_dir=_env_path("VOXSOAP_ASR_ADAPTER_DIR") or (
            _FULLSCALE_ARTIFACTS / "asr" / "whisper-lora-ur-20261030-165202"
        ),
        soap_base_model=_env_str("VOXSOAP_SOAP_BASE_MODEL", "Qwen/Qwen2.5-3B-Instruct"),
        soap_base_revision=_env_str("VOXSOAP_SOAP_BASE_REVISION", "main"),
        soap_adapter_dir=_env_path("VOXSOAP_SOAP_ADAPTER_DIR") or (
            _FULLSCALE_ARTIFACTS / "soap" / "soap-lora-20261030-165202"
        ),
        soap_system_prompt=_env_str("VOXSOAP_SOAP_SYSTEM_PROMPT", DEFAULT_SOAP_SYSTEM_PROMPT),
        roman_base_model=_env_str("VOXSOAP_ROMAN_BASE_MODEL", "google/mt5-small"),
        roman_base_revision=_env_str("VOXSOAP_ROMAN_BASE_REVISION", "main"),
        roman_adapter_dir=_env_path("VOXSOAP_ROMAN_ADAPTER_DIR"),
        gemini_proxy_url=_env_optional_str("VOXSOAP_GEMINI_PROXY_URL"),
        host=_env_str("VOXSOAP_HOST", "127.0.0.1"),
        port=int(_env_str("VOXSOAP_PORT", "8321")),
        device=_env_str("VOXSOAP_DEVICE", "auto"),
        target_sample_rate=int(_env_str("VOXSOAP_TARGET_SAMPLE_RATE", "16000")),
        max_audio_mb=float(_env_str("VOXSOAP_MAX_AUDIO_MB", "25.0")),
        transcript_max_chars=int(_env_str("VOXSOAP_TRANSCRIPT_MAX_CHARS", "14000")),
        asr_max_new_tokens=int(_env_str("VOXSOAP_ASR_MAX_NEW_TOKENS", "256")),
        draft_max_new_tokens=int(_env_str("VOXSOAP_DRAFT_MAX_NEW_TOKENS", "512")),
        soap_dtype=_env_str("VOXSOAP_SOAP_DTYPE", "auto").strip().lower(),
        soap_backend=soap_backend,
        soap_gguf_repo=_env_str("VOXSOAP_SOAP_GGUF_REPO", "Qwen/Qwen2.5-1.5B-Instruct-GGUF"),
        soap_gguf_file=_env_str(
            "VOXSOAP_SOAP_GGUF_FILE", "qwen2.5-1.5b-instruct-q4_k_m.gguf"
        ),
        soap_gguf_path=_env_path("VOXSOAP_SOAP_GGUF_PATH"),
        soap_n_ctx=soap_n_ctx,
        soap_n_threads=soap_n_threads,
        soap_n_batch=soap_n_batch,
        soap_n_ubatch=soap_n_ubatch,
        roman_max_new_tokens=int(_env_str("VOXSOAP_ROMAN_MAX_NEW_TOKENS", "256")),
    )
