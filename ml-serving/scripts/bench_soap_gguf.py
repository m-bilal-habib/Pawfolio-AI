"""Real-hardware benchmark for the quantized GGUF SOAP backend (2026-11-19).

This script is NOT part of the mocked test suite: it loads the actual GGUF
weights and runs one cold draft on this machine. It records cold-load seconds,
generation seconds, tokens, tok/s, peak process RSS, the hydrated 23-parameter
objective map, and deterministic guard flags so the owner decision in
ml-serving/reports/phase5_integration_plan.md §14 is measured, never guessed.

Usage (from the repo root):
  .venv-ml64\\Scripts\\python ml-serving\\scripts\\bench_soap_gguf.py \
      --repo Qwen/Qwen2.5-3B-Instruct-GGUF \
      --file qwen2.5-3b-instruct-q4_k_m.gguf \
      --threads 3 --max-new-tokens 320 \
      --json-out ml-serving/reports/bench-3b-q4km-t3.json
"""
from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import psutil

SERVING_DIR = Path(__file__).resolve().parents[1]
if str(SERVING_DIR) not in sys.path:
    sys.path.insert(0, str(SERVING_DIR))

from config import ServingConfig  # noqa: E402
from guards import clinical_guard  # noqa: E402
from providers import (  # noqa: E402
    MLProvider,
    VET_OBJECTIVE_PARAMS,
    VET_NOT_MENTIONED,
)

DEFAULT_TRANSCRIPT = SERVING_DIR / "tests" / "fixtures" / "leo_consult_5min.txt"


_PROCESS = psutil.Process()


def current_rss_mb() -> float:
    return _PROCESS.memory_info().rss / (1024 * 1024)


def peak_rss_mb() -> float:
    # Windows exposes the lifetime peak working set; fall back to current RSS.
    info = _PROCESS.memory_info()
    return float(getattr(info, "peak_wset", info.rss)) / (1024 * 1024)


class RssSampler:
    """Samples working-set RSS while the model loads/generates."""

    def __init__(self, interval_s: float = 0.1):
        self.interval_s = interval_s
        self.samples: List[Tuple[float, float]] = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)

    def _loop(self) -> None:
        started = time.perf_counter()
        while not self._stop.is_set():
            self.samples.append((time.perf_counter() - started, current_rss_mb()))
            time.sleep(self.interval_s)

    def __enter__(self) -> "RssSampler":
        self._thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self._stop.set()
        self._thread.join(timeout=2.0)

    @property
    def max_mb(self) -> float:
        return max((rss for _, rss in self.samples), default=current_rss_mb())


def _cited(value: str, *needles: str) -> bool:
    low = (value or "").lower()
    return any(needle in low for needle in needles)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default="Qwen/Qwen2.5-3B-Instruct-GGUF")
    parser.add_argument("--file", default="qwen2.5-3b-instruct-q4_k_m.gguf")
    parser.add_argument("--path", default=None, help="explicit local .gguf path")
    parser.add_argument("--threads", type=int, default=3, help="VOXSOAP_SOAP_N_THREADS")
    parser.add_argument("--n-ctx", type=int, default=4096, help="VOXSOAP_SOAP_N_CTX")
    parser.add_argument("--n-batch", type=int, default=128, help="VOXSOAP_SOAP_N_BATCH")
    parser.add_argument("--n-ubatch", type=int, default=128, help="VOXSOAP_SOAP_N_UBATCH")
    parser.add_argument("--max-new-tokens", type=int, default=320)
    parser.add_argument(
        "--device",
        default="cpu",
        choices=["cpu"],
        help="benchmark is CPU-only; VOXSOAP_DEVICE=cpu also skips the torch import "
        "(the real owner-box service runs with this declaration)",
    )
    parser.add_argument("--transcript", default=str(DEFAULT_TRANSCRIPT))
    parser.add_argument("--json-out", default=None)
    parser.add_argument("--draft-out", default=None)
    args = parser.parse_args()

    transcript = Path(args.transcript).read_text(encoding="utf-8").strip()
    if not transcript:
        print("ERROR: transcript file is empty", file=sys.stderr)
        return 2

    cfg = ServingConfig(
        soap_backend="gguf",
        soap_gguf_repo=args.repo,
        soap_gguf_file=args.file,
        soap_gguf_path=Path(args.path) if args.path else None,
        soap_n_ctx=max(512, args.n_ctx),
        soap_n_threads=max(0, args.threads),
        soap_n_batch=max(1, args.n_batch),
        soap_n_ubatch=max(1, min(args.n_ubatch, args.n_batch)),
        device=args.device,
    )
    provider = MLProvider(cfg)

    baseline = current_rss_mb()
    started = time.perf_counter()
    device = provider._resolve_device()  # VOXSOAP_DEVICE=cpu: no torch import
    torch_ready_s = time.perf_counter() - started
    if device != "cpu":
        print(f"ERROR: resolved device={device!r}; this benchmark is CPU-only", file=sys.stderr)
        return 2

    result: Dict[str, Any] = {
        "backend": "gguf",
        "repo": args.repo,
        "model_file": args.file,
        "explicit_path": args.path,
        "n_ctx": cfg.soap_n_ctx,
        "n_threads": args.threads,
        "n_batch": cfg.soap_n_batch,
        "n_ubatch": cfg.soap_n_ubatch,
        "max_new_tokens_requested": args.max_new_tokens,
        "transcript_chars": len(transcript),
        "device": device,
        "baseline_rss_mb": round(baseline, 1),
        "torch_import_s": round(torch_ready_s, 1),
    }

    token_times: List[Tuple[int, float]] = []

    def progress(tokens: int) -> None:
        token_times.append((tokens, time.perf_counter()))

    with RssSampler() as sampler:
        load_started = time.perf_counter()
        state = provider._load_soap_gguf()
        load_s = time.perf_counter() - load_started
        loaded_rss = current_rss_mb()

        gen_started = time.perf_counter()
        payload = provider.draft(
            transcript,
            max_new_tokens=args.max_new_tokens,
            note_format="vet_scribenote",
            progress_cb=progress,
        )
        gen_s = time.perf_counter() - gen_started

    tokens_generated = token_times[-1][0] if token_times else 0
    ttft_s = (
        round(token_times[0][1] - gen_started, 2) if token_times else None
    )
    sections = payload.get("sections") or {}
    objective: Dict[str, str] = sections.get("objective_map") or {}
    mentioned = {
        name: value
        for name, value in objective.items()
        if value and value != VET_NOT_MENTIONED
    }
    guard = clinical_guard(payload.get("draft", ""), transcript)

    quality = {
        "objective_param_count": len(objective),
        "objective_params_in_order": list(objective.keys()) == list(VET_OBJECTIVE_PARAMS),
        "mentioned_count": len(mentioned),
        "mentioned": mentioned,
        "weight_24_1": _cited(objective.get("Weight", ""), "24.1", "twenty-four point one"),
        "temperature_38_9": _cited(objective.get("Temperature", ""), "38.9"),
        "heart_rate_120": _cited(objective.get("Heart Rate", ""), "120"),
        "respiratory_rate_28": _cited(objective.get("Respiratory Rate", ""), "28"),
        "ears_populated": _cited(objective.get("Ears", ""), "erythemat", "red", "debris", "waxy"),
        "integument_populated": _cited(objective.get("Integument", ""), "pyoderma", "papule"),
        "musculoskeletal_populated": _cited(
            objective.get("Musculoskeletal", ""), "crepitus", "stifle", "sound"
        ),
        "complete_schema": bool((guard.get("schema") or {}).get("complete_schema")),
        "unsupported_numbers_in_draft": (guard.get("facts") or {}).get(
            "unsupported_numbers_in_draft", []
        ),
        "unsupported_med_tokens_in_draft": (guard.get("facts") or {}).get(
            "unsupported_med_tokens_in_draft", []
        ),
        "trace_drops_in_note": "dropped: no verbatim trace" in str(payload.get("note", "")),
        "model_scale": payload.get("model_scale"),
    }

    result.update(
        {
            "cold_load_s": round(load_s, 2),
            "generate_s": round(gen_s, 2),
            "cold_total_s": round(torch_ready_s + load_s + gen_s, 2),
            "tokens_generated": tokens_generated,
            "max_new_tokens_applied": payload.get("max_new_tokens"),
            "tok_per_s": round(tokens_generated / gen_s, 3) if gen_s > 0 else None,
            "ttft_s": ttft_s,
            "loaded_rss_mb": round(loaded_rss, 1),
            "peak_rss_mb": round(max(peak_rss_mb(), sampler.max_mb), 1),
            "rss_samples": len(sampler.samples),
            "quality": quality,
        }
    )

    draft_text = str(payload.get("draft", ""))
    if args.draft_out:
        Path(args.draft_out).write_text(draft_text, encoding="utf-8")
    if args.json_out:
        Path(args.json_out).write_text(
            json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8"
        )

    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
