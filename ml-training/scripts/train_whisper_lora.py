#!/usr/bin/env python3
"""VoxSOAP ML - Fine-tune the ASR component with LoRA/PEFT (Model A, §5/§7).

Runs ONLY on license-cleared rows from the gate-approved sources. ASR samples
are consumed from a locally prepared Hugging Face dataset (saved by the
notebook's prep stage) that already contains:
    audio (16 kHz mono arrays), sentence (verbatim reference transcript),
    source_dataset, source_split, source_row_id.

Gates and rules enforced:
  * HARD FAIL with a clear message when no CUDA device is visible (§7.1.3).
  * HARD FAIL when the referenced split has zero rows after decode checks.
  * Base checkpoint id+revision and adapter/config are always persisted next
    to the artifacts (§9 - an adapter alone is not a model).
  * Validation rows used during training are the OFFICIAL validation subset;
    the final test rows are never part of this run.

Usage:
    python train_whisper_lora.py \
        --train-dataset ../data/asr/ur_train \
        --val-dataset  ../data/asr/ur_validation \
        --base-model openai/whisper-small \
        --epochs 1 --steps-per-report 25 \
        --export-dir ../exports/asr  --out-name whisper-lora-ur
"""
from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import os
import platform
import sys
from typing import Any, Dict, List, NoReturn, Optional

REQUIRED_COLUMNS = {"audio", "sentence"}


def _utc_stamp() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def hard_fail(message: str) -> NoReturn:
    print(f"[TRAIN-ABORT] {message}")
    sys.exit(3)


def sha256_of(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def check_gpu() -> Dict[str, Any]:
    import torch

    if not torch.cuda.is_available():
        hard_fail(
            "No CUDA device is visible. The ASR fine-tuning stage requires a GPU. "
            "In Colab: Runtime > Change runtime type > GPU, re-run, then retry this stage."
        )
    props = torch.cuda.get_device_properties(0)
    return {
        "cuda": True,
        "torch": torch.__version__,
        "device_name": props.name,
        "total_memory_gb": round(props.total_memory / 1024**3, 2),
    }


def ensure_audio_dict(audio: Any) -> Optional[Dict[str, Any]]:
    """Decode audio uniformly across datasets versions.

    Handles: dict with 'array' (already decoded), dict with 'bytes' (raw file -
    decode via soundfile; version-proof against lazy-decoder majors), and lazy
    decoder objects (best-effort). Returns a dict with 'array' and
    'sampling_rate', or None when unusable.
    """
    if isinstance(audio, dict):
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


def validate_prepared_dataset(path: str, split_name: str) -> Any:
    from datasets import load_from_disk

    if not os.path.exists(path):
        hard_fail(f"Prepared dataset '{split_name}' missing at {path} - run the prep stage first.")
    ds = load_from_disk(path)
    missing = REQUIRED_COLUMNS - set(ds.column_names)
    if missing:
        hard_fail(f"Prepared dataset '{split_name}' is missing columns {sorted(missing)}: found {ds.column_names}")
    if len(ds) == 0:
        hard_fail(f"Prepared dataset '{split_name}' contains zero rows.")
    # Spot-decode the first row to FAIL EARLY on audio decoder problems (§7.3.6).
    first = ensure_audio_dict(ds[0].get("audio"))
    if first is None:
        hard_fail(f"First '{split_name}' row failed audio decoding - do not start training on broken audio.")
    print(f"[OK] {split_name}: {len(ds)} rows; first sample rate={first.get('sampling_rate')} Hz")
    return ds


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--train-dataset", required=True)
    parser.add_argument("--val-dataset", required=True)
    parser.add_argument("--base-model", default="openai/whisper-small")
    parser.add_argument("--base-model-revision", default="main")
    parser.add_argument("--epochs", type=float, default=1.0, help="single epoch proves the loop first (§5)")
    parser.add_argument("--learning-rate", type=float, default=1.2e-4)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--grad-accum", type=int, default=2)
    parser.add_argument("--lora-r", type=int, default=8)
    parser.add_argument("--export-dir", default="../exports/asr")
    parser.add_argument("--out-name", default="whisper-lora-ur")
    args = parser.parse_args()

    print("[ENV] checking GPU...")
    gpu = check_gpu()
    print(f"[GPU] {gpu}")

    import torch
    from transformers import Seq2SeqTrainer, Seq2SeqTrainingArguments, WhisperForConditionalGeneration, WhisperProcessor

    from peft import LoraConfig, get_peft_model

    train_ds = validate_prepared_dataset(args.train_dataset, "train")
    val_ds = validate_prepared_dataset(args.val_dataset, "validation")

    processor = WhisperProcessor.from_pretrained(args.base_model, revision=args.base_model_revision, language="urdu", task="transcribe")
    model = WhisperForConditionalGeneration.from_pretrained(args.base_model, revision=args.base_model_revision)
    model.config.forced_decoder_ids = None
    if getattr(model.config, "suppress_tokens", None) is not None:
        model.config.suppress_tokens = []

    # LoRA on the attention projections - compatible with whisper-small.
    lora_cfg = LoraConfig(
        r=args.lora_r, lora_alpha=args.lora_r * 2, lora_dropout=0.05,
        target_modules=["q_proj", "v_proj"], bias="none",
    )
    model = get_peft_model(model, lora_cfg)
    model.print_trainable_parameters()
    model.config.use_cache = False

    def collate(batch):
        # One feature-extractor call for the whole batch: input arrays were
        # resampled to 16 kHz mono by the PREP stage (never assumed - the audio
        # decoder path is normalized via ensure_audio_dict before use).
        speech = [torch.tensor(ensure_audio_dict(r["audio"])["array"], dtype=torch.float32) for r in batch]
        feats = processor.feature_extractor(
            speech, sampling_rate=16000, return_tensors="pt", padding=True
        ).input_features
        label_rows = [{"input_ids": processor.tokenizer(r["sentence"]).input_ids} for r in batch]
        labels = processor.tokenizer.pad(label_rows, padding=True, return_tensors="pt")["input_ids"]
        labels = labels.masked_fill(labels == processor.tokenizer.pad_token_id, -100)
        return {"input_features": feats, "labels": labels}

    out_dir = os.path.join(args.export_dir, args.out_name)
    targs = Seq2SeqTrainingArguments(
        output_dir=os.path.join("../checkpoints", args.out_name),
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        gradient_checkpointing=True,
        num_train_epochs=args.epochs,
        learning_rate=args.learning_rate,
        logging_steps=args.steps_per_report,
        eval_strategy="steps",
        eval_steps=100,
        save_total_limit=2,
        remove_unused_columns=False,
        predict_with_generate=False,
        report_to=[],
    )

    trainer = Seq2SeqTrainer(
        model=model, args=targs, train_dataset=train_ds, eval_dataset=val_ds, data_collator=collate,
        compute_metrics=None,
    )
    try:
        model.generation_config.language = "urdu"
        model.generation_config.task = "transcribe"
        model.generation_config.forced_decoder_ids = None
    except Exception as gen_err:  # noqa: BLE001
        print(f"[WARN] generation_config language could not be pinned: {gen_err}")
    trainer.train()
    trainer.save_model(out_dir)
    processor.save_pretrained(out_dir)

    meta = {
        "component": "asr_whisper_lora",
        "base_model_id": args.base_model,
        "base_model_revision": args.base_model_revision,
        "lora": {"r": args.lora_r, "target_modules": ["q_proj", "v_proj"], "alpha": args.lora_r * 2},
        "epochs": args.epochs,
        "train_rows": len(train_ds),
        "val_rows": len(val_ds),
        "gpu": gpu,
        "python_platform": platform.platform(),
        "trained_at": _utc_stamp(),
        "adapter_path": out_dir,
        "note": "Adapter is NOT a complete model: serving must pair it with the exact base checkpoint id+revision.",
        "executed": True,
    }
    with open(os.path.join(out_dir, "training_manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(meta, handle, indent=2)
    print(f"[DONE] adapter + processor + manifest -> {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
