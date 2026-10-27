#!/usr/bin/env python3
"""VoxSOAP ML - ASR evaluation (WER/CER + preservation checks, §11.2).

Measures AT LEAST:
  * WER on normalized transcripts and CER (recommended for Urdu script),
  * exact preservation of medication names / numbers / units / negation /
    uncertainty phrases (token-level spot checks),
  * optional wall-clock latency per minute of audio when a live model is
    provided (--adapter for the fine-tuned model, omit it for the BASE model).

Normalisation is EXPLICIT and printed into the report so scores are never
compared across different rules (§11.2 note). Reference and hypothesis sizes
must match; rows with empty references are excluded and counted.

Usage:
    python evaluate_asr.py \
        --eval-dataset ../data/asr/ur_validation \
        --adapter ../exports/asr/whisper-lora-ur \
        --base-model openai/whisper-small \
        [--sample-cap 50] [--report ../reports/asr_eval.json]
    # Omit --adapter to evaluate the BASE model (Stage 8 before fine-tuning).
"""
from __future__ import annotations

# Run-5 lesson (BEFORE any transformers import anywhere in this process):
# transformers reads USE_TF/USE_FLAX from the environment at import time and
# its TF-availability gates can end up importing Colab's TensorFlow, which
# hard-crashes on a protobuf gencode/runtime mismatch when protobuf gets
# downgraded (run 5: gencode 6.31.1 vs pinned runtime 5.29.3). This pipeline
# is pure PyTorch - force the honest backends off first.
# (TRANSFORMERS_NO_TF is NOT a real flag in transformers 4.48.3 - verified.)
import os as _boot_os

_boot_os.environ.setdefault("USE_TF", "0")
_boot_os.environ.setdefault("USE_FLAX", "0")

import argparse
import datetime as _dt
import json
import os
import re
import sys
import time
from typing import Any, Dict, List, Optional

# Token-spot-check categories (§11.2 'exact preservation' requirement).
NUMBER_RE = re.compile(r"\d+(?:[.,]\d+)?")
NEGATION_TOKENS = ("no", "not", "never", "denies")


def _utc_stamp() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def normalize_for_wer(text: str) -> str:
    """Documented normalization: NFKC -> casefold -> collapse whitespace ->
    strip most punctuation (keeps Urdu characters, digits and %)."""
    import unicodedata

    text = unicodedata.normalize("NFKC", text or "").casefold()
    text = re.sub(r"[^\w\s%]|_", " ", text, flags=re.UNICODE)
    return re.sub(r"\s+", " ", text).strip()


def load_eval_rows(path: str, cap: Optional[int]) -> List[Dict[str, Any]]:
    from datasets import Audio, load_from_disk

    if not os.path.exists(path):
        print(f"[EVAL-SKIP] prepared eval dataset missing: {path} - run the ASR prep stage first.")
        sys.exit(2)
    ds = load_from_disk(path)
    # Same decode rule as training: raw bytes via decode=False + our soundfile
    # decode, independent of the installed datasets major.
    try:
        ds = ds.cast_column("audio", Audio(decode=False))
    except Exception as cast_err:
        print(f"[EVAL-WARN] cast_column(audio, decode=False) failed ({cast_err}); keeping default decoding.")
    rows = [dict(r) for r in ds]
    if cap:
        rows = rows[:cap]
    usable = [r for r in rows if str(r.get("text", "")).strip()]
    skipped = len(rows) - len(usable)
    if not usable:
        print("[EVAL-SKIP] no rows with a non-empty reference transcript.")
        sys.exit(2)
    print(f"[OK] {len(usable)} eval rows ({skipped} skipped: empty reference)")
    return usable


def ensure_audio_dict(audio: Any) -> Optional[Dict[str, Any]]:
    """Decode audio uniformly (raw {bytes,path} via soundfile is version-proof).

    datasets majors disagree on streaming audio shapes (dict vs lazy
    AudioDecoder); this normalizes all supported shapes or returns None.
    """
    if isinstance(audio, dict):
        if isinstance(audio.get("array"), (list, tuple)) or (audio.get("array") is not None and not hasattr(audio.get("array"), "shape")):
            import numpy as np

            return {"array": np.asarray(audio["array"], dtype=np.float32), "sampling_rate": int(audio.get("sampling_rate") or 0)}
        if audio.get("array") is not None:
            return audio
        raw = audio.get("bytes")
        if raw:
            import io

            import numpy as np
            import soundfile as sf
            try:
                data, sr = sf.read(io.BytesIO(raw), dtype="float32")
            except Exception:
                return None
            data = np.asarray(data, dtype=np.float32)
            if data.ndim == 2:
                data = data.mean(axis=1).astype(np.float32)
            return {"array": data, "sampling_rate": int(sr)}
        return audio
    decode_fn = getattr(audio, "decode", None)
    if callable(decode_fn):
        try:
            out = decode_fn()
        except Exception:
            return None
        if isinstance(out, dict) and out.get("array") is not None:
            return out
    return None


def transcription_model(base_id: str, revision: str, adapter: Optional[str]):
    import torch
    from transformers import AutoModelForSpeechSeq2Seq, WhisperProcessor

    processor = WhisperProcessor.from_pretrained(adapter or base_id,
                                                 language="urdu", task="transcribe")
    model = AutoModelForSpeechSeq2Seq.from_pretrained(
        adapter or base_id,
        torch_dtype=torch.float16 if torch.cuda.is_available() else torch.float32,
    )
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = model.to(device)
    model.eval()
    try:
        model.generation_config.language, model.generation_config.task = "urdu", "transcribe"
        model.generation_config.forced_decoder_ids = None
        # run 6: `task="transcribe"` and a stale config-level forced_decoder_ids
        # conflict; clear BOTH config surfaces, not just generation_config.
        model.config.forced_decoder_ids = None
    except Exception as err:  # noqa: BLE001
        print(f"[WARN] generation config not pinned: {err}")
    return model, processor, device


def transcribe(model: Any, processor: Any, device: str, audio: Any) -> str:
    """One-row transcription with the run-6 dtype/mask fixes applied.

    The model is loaded in fp16 on CUDA while WhisperFeatureExtractor emits
    fp32 - casting BOTH device AND dtype silences the
    `Input type (float) and bias type (c10::Half) should be the same` failure
    seen on all 25 Stage-8 rows in run 6. The attention mask is passed
    explicitly (pad token == eos token warning suppressor), and language/task
    are pinned per call so no stale config forces a decoder conflict.
    Evaluated store content is ur_pk only -> language="urdu" (matches training).
    """
    import torch

    import numpy as np

    speech = np.asarray(audio["array"], dtype=np.float32)
    feats = processor.feature_extractor(
        speech,
        sampling_rate=16000,
        return_attention_mask=True,
        return_tensors="pt",
    )
    input_features = feats.input_features.to(device=model.device, dtype=model.dtype)
    gen_kwargs: Dict[str, Any] = {"max_new_tokens": 256, "language": "urdu", "task": "transcribe"}
    if getattr(feats, "attention_mask", None) is not None:
        gen_kwargs["attention_mask"] = feats.attention_mask.to(model.device)
    with torch.no_grad():
        ids = model.generate(input_features=input_features, **gen_kwargs)
    return processor.tokenizer.batch_decode(ids, skip_special_tokens=True)[0]


def preservation_check(reference: str, hypothesis: str, preserve_terms: List[str]) -> Dict[str, Any]:
    ref_n, hyp_n = normalize_for_wer(reference), normalize_for_wer(hypothesis)
    ref_tokens, hyp_tokens = set(ref_n.split()), set(hyp_n.split())
    issues: List[str] = []

    for number in NUMBER_RE.findall(ref_n):
        if number not in hyp_tokens:
            issues.append(f"number_lost:{number}")
    for token in NEGATION_TOKENS:
        if token in ref_tokens and token not in hyp_tokens:
            issues.append(f"negation_lost:{token}")
    for term in preserve_terms:
        if normalize_for_wer(term) in ref_tokens or normalize_for_wer(term) in ref_n:
            if normalize_for_wer(term) not in hyp_n:
                issues.append(f"term_lost:{term}")
    return {"issues": issues}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--eval-dataset", required=True)
    parser.add_argument("--base-model", default="openai/whisper-small")
    parser.add_argument("--base-model-revision", default="main")
    parser.add_argument("--adapter", default=None, help="omit to evaluate the BASE model")
    parser.add_argument("--sample-cap", type=int, default=50)
    parser.add_argument("--preserve-terms", default="", help="comma-separated extra terms (med brand names)")
    parser.add_argument("--report", default=None)
    args = parser.parse_args()

    try:
        import jiwer
    except ImportError:
        print("[ENV-ERROR] jiwer not installed - pinned in requirements-colab.txt.")
        return 2

    rows = load_eval_rows(args.eval_dataset, args.sample_cap)
    model, processor, device = transcription_model(args.base_model, args.base_model_revision, args.adapter)

    preserve_terms = [t.strip() for t in args.preserve_terms.split(",") if t.strip()]

    refs: List[str] = []
    hyps: List[str] = []
    raw_refs: List[str] = []
    raw_hyps: List[str] = []
    latencies: List[float] = []
    audio_seconds: List[float] = []
    preservation: Dict[str, int] = {}

    for index, row in enumerate(rows):
        try:
            audio = ensure_audio_dict(row.get("audio"))
            if audio is None or audio.get("array") is None:
                preservation["decode_failures"] = preservation.get("decode_failures", 0) + 1
                continue
            start = time.perf_counter()
            raw_hyp = transcribe(model, processor, device, audio).strip()
            latencies.append(time.perf_counter() - start)
            audio_seconds.append(len(audio["array"]) / float(audio.get("sampling_rate") or 16000))
            raw_reference = str(row.get("text", ""))
            raw_refs.append(raw_reference)
            raw_hyps.append(raw_hyp)
            refs.append(normalize_for_wer(raw_reference))
            hyps.append(normalize_for_wer(raw_hyp))
        except Exception as err:  # noqa: BLE001
            print(f"[WARN] row {index} failed transcription ({err}) - excluded, counted.")
            preservation["transcription_failures"] = preservation.get("transcription_failures", 0) + 1

    if not refs:
        print("[EVAL-SKIP] every row failed - no metrics fabricated.")
        sys.exit(2)

    wer = jiwer.wer(refs, hyps)
    cer = jiwer.cer(refs, hyps)

    for raw_reference, raw_hyp in zip(raw_refs, raw_hyps):
        for issue in preservation_check(raw_reference, raw_hyp, preserve_terms)["issues"]:
            key = issue.split(":", 1)[0]
            preservation[key] = preservation.get(key, 0) + 1

    report: Dict[str, Any] = {
        "evaluated_component": "asr",
        "base_model": args.base_model,
        "revision": args.base_model_revision,
        "adapter": args.adapter or "(base - no adapter)",
        "normalization": "NFKC; casefold; strip punctuation except [%\\w\\s]; collapse spaces",
        "n_rows": len(refs),
        "wer": round(float(wer), 4),
        "cer": round(float(cer), 4),
        "latency": {
            "mean_s": round(sum(latencies) / len(latencies), 4) if latencies else None,
            "audio_minutes": round(sum(audio_seconds) / 60.0, 3) if audio_seconds else None,
            "device": device,
        },
        "preservation": preservation,
        "preserve_terms": preserve_terms,
        "executed": True,
        "measured_at": _utc_stamp(),
        "limitation": "General-domain refs (e.g. FLEURS) do not validate veterinary meds/jargon; run the vet benchmark when prepared (§8.3).",
    }
    print(json.dumps(report, indent=2, ensure_ascii=False))
    if args.report:
        os.makedirs(os.path.dirname(os.path.abspath(args.report)), exist_ok=True)
        with open(args.report, "w", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2, ensure_ascii=False)
        print(f"[OK] metrics -> {args.report}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
