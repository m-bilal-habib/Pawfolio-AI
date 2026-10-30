"""VoxSOAP ML serving configuration (Phase 4 scaffold - contract §9 region).

Every knob is environment-driven with a VOXSOAP_ prefix so the app can be
retargeted without code edits. Defaults point at the unpacked PHASE-2 SMOKE
adapters under ml-training/artifacts/ - development/smoke ONLY, never a
production claim.

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

# Development default: the verified Phase-2 smoke export (run 8, pre-tag
# manifests) - kept for reference; the ACTIVE defaults below point at run 9.
_DEFAULT_ARTIFACTS = (
    REPO_ROOT / "ml-training" / "artifacts" / "unpacked_voxsoap_ml_exports_20261027-181112"
)

# Run-9 verified artifacts (RUN_ID 20261028-142956, full-scale tags recorded in
# each training manifest). ASR + SOAP defaults point here.
# Model C (Roman Urdu transliteration) is DEPRECATED (2026-10-29, runs 9/10/11):
# every training recipe failed its evaluation - run-9 emitted ONLY the mT5
# span-corruption sentinel '<extra_id_0>' (CER 0.9142), run-10 plateaued at
# loss ~= ln(vocab) (CER 6.1456), run-11 degenerated into repetition loops
# (CER 6.8905, exact_match 0.0). The roman default therefore stays None and
# /roman answers an honest 501; VOXSOAP_ROMAN_ADAPTER_DIR remains a
# diagnostics-only override for a supervised owner-approved re-enable.
_RUN9_ARTIFACTS = (
    REPO_ROOT / "ml-training" / "artifacts" / "unpacked_voxsoap_ml_exports_20261028-142956"
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
    asr_adapter_dir: Optional[Path] = _RUN9_ARTIFACTS / "asr" / "whisper-lora-ur-20261028-142956"
    # SOAP component.
    soap_base_model: str = "Qwen/Qwen2.5-3B-Instruct"
    soap_base_revision: str = "main"
    soap_adapter_dir: Optional[Path] = _RUN9_ARTIFACTS / "soap" / "soap-lora-20261028-142956"
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
    draft_max_new_tokens: int = 512    # phase-3 fix for the 256-token truncations
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
    return ServingConfig(
        default_provider=provider,
        asr_base_model=_env_str("VOXSOAP_ASR_BASE_MODEL", "openai/whisper-small"),
        asr_base_revision=_env_str("VOXSOAP_ASR_BASE_REVISION", "main"),
        asr_adapter_dir=_env_path("VOXSOAP_ASR_ADAPTER_DIR") or (
            _RUN9_ARTIFACTS / "asr" / "whisper-lora-ur-20261028-142956"
        ),
        soap_base_model=_env_str("VOXSOAP_SOAP_BASE_MODEL", "Qwen/Qwen2.5-3B-Instruct"),
        soap_base_revision=_env_str("VOXSOAP_SOAP_BASE_REVISION", "main"),
        soap_adapter_dir=_env_path("VOXSOAP_SOAP_ADAPTER_DIR") or (
            _RUN9_ARTIFACTS / "soap" / "soap-lora-20261028-142956"
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
        roman_max_new_tokens=int(_env_str("VOXSOAP_ROMAN_MAX_NEW_TOKENS", "256")),
    )
