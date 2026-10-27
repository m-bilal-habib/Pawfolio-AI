#!/usr/bin/env python3
"""VoxSOAP ML - Fine-tune the ASR component with LoRA/PEFT (Model A, §5/§7).

Runs ONLY on license-cleared rows from the gate-approved sources. ASR samples
are consumed from a locally prepared Hugging Face dataset (saved by the
notebook's prep stage, run-6 canonical schema) that already contains:
    audio (16 kHz mono float32 arrays), text (verbatim reference transcript).
Provenance (source_dataset/split/row_id) lives in the prep report, not in
the store - see the Stage 7 notebook cell.

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
import hashlib
import json
import os
import platform
import sys
from typing import Any, Dict, List, NoReturn, Optional

REQUIRED_COLUMNS = {"audio", "text"}


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
    from datasets import Audio, load_from_disk

    if not os.path.exists(path):
        hard_fail(f"Prepared dataset '{split_name}' missing at {path} - run the prep stage first.")
    ds = load_from_disk(path)
    # Read audio as RAW BYTES (decode=False) and decode through the SAME
    # soundfile path the prep stage used. Datasets majors disagree on decoded
    # audio shapes and newer majors hand back lazy decoder objects even for
    # load_from_disk rows (observed in runs 2-3) - do not leave row decoding
    # to the installed datasets version.
    try:
        ds = ds.cast_column("audio", Audio(decode=False))
    except Exception as cast_err:
        print(f"[WARN] cast_column(audio, decode=False) failed ({cast_err}); keeping default decoding.")
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
    parser.add_argument("--steps-per-report", type=int, default=25, help="trainer logging interval in optimiser steps (documented in the usage example - was never declared, crashed Stage 9 in run 5 after line 203 used it)")
    parser.add_argument("--learning-rate", type=float, default=1.2e-4)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--grad-accum", type=int, default=2)
    parser.add_argument("--lora-r", type=int, default=8)
    parser.add_argument("--lora-targets", default="q_proj,v_proj",
                        help="comma-separated attention modules to LoRA (phase 3 full run passes q_proj,k_proj,v_proj,o_proj)")
    parser.add_argument("--eval-steps", type=int, default=50,
                        help="trainer eval interval in steps (phase-3 scale: runs actually fire; smoke epochs were too short)")
    parser.add_argument("--warmup-ratio", type=float, default=0.05)
    parser.add_argument("--model-scale", choices=["smoke", "full"], default="smoke",
                        help="honest scale tag recorded in the training manifest; serving surfaces it in every response")
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
    lora_targets = [t.strip() for t in args.lora_targets.split(",") if t.strip()]
    lora_cfg = LoraConfig(
        r=args.lora_r, lora_alpha=args.lora_r * 2, lora_dropout=0.05,
        target_modules=lora_targets, bias="none",
    )
    model = get_peft_model(model, lora_cfg)
    model.print_trainable_parameters()

    # Run-7 lesson (PEFT + gradient checkpointing on Whisper is a graph killer):
    # reentrant checkpointing drops the autograd graph when NO checkpointed
    # input requires grad. enable_input_require_grads() only covers the
    # DECODER embeddings (get_input_embeddings()); the audio encoder's conv1
    # input is NOT covered by it, so a forward hook makes conv1 outputs
    # require grad explicitly (this is what "None of the inputs have
    # requires_grad=True / grads will be None" was warning about in run 7).
    # Path note, source-checked on peft 0.18.1: peft_model.model resolves to
    # the WhisperForConditionalGeneration (LoraModel.model), whose .model is
    # the inner WhisperModel holding .encoder.conv1.
    model.enable_input_require_grads()

    def _make_inputs_require_grad(module, _input, output):
        output.requires_grad_(True)

    model.get_base_model().model.encoder.conv1.register_forward_hook(_make_inputs_require_grad)
    model.config.use_cache = False

    def collate(batch):
        # Run-6 hardening: speech must be a PYTHON LIST of 1D contiguous
        # float32 arrays of possibly different lengths. A batched 2D/object
        # numpy array sent WhisperFeatureExtractor into np.asarray and crashed
        # with "inhomogeneous shape". Audio is mono/16k from Stage 7's store,
        # but never assumed: decode, mono-merge and sampling rates are asserted.
        import numpy as np

        speech, srs = [], set()
        for r in batch:
            audio = ensure_audio_dict(r["audio"])
            if audio is None or audio.get("array") is None:
                hard_fail("collate received a row whose audio failed to decode - rerun Stage 7 (asr_capped_training_prep).")
            arr = np.asarray(audio["array"], dtype=np.float32)
            if arr.ndim > 1:
                arr = arr.mean(axis=-1)
            speech.append(np.ascontiguousarray(arr.reshape(-1), dtype=np.float32))
            srs.add(int(audio.get("sampling_rate") or 0))
        if srs != {16000}:
            hard_fail(f"collate saw mixed/unknown sampling rates {sorted(srs)} - Stage 7 must normalize every row to 16 kHz.")
        # Deterministic 30 s window: padding="max_length" fixes the feature
        # shape (3000 frames) across the batch/eval/checkpoint paths, per the
        # Whisper length convention (480,000 samples @ 16 kHz).
        feats = processor.feature_extractor(
            speech, sampling_rate=16000, return_tensors="pt", padding="max_length"
        ).input_features
        label_rows = [{"input_ids": processor.tokenizer(r["text"]).input_ids} for r in batch]
        labels = processor.tokenizer.pad(label_rows, padding=True, return_tensors="pt")["input_ids"]
        labels = labels.masked_fill(labels == processor.tokenizer.pad_token_id, -100)
        return {"input_features": feats, "labels": labels}

    out_dir = os.path.join(args.export_dir, args.out_name)
    targs = Seq2SeqTrainingArguments(
        output_dir=os.path.join("../checkpoints", args.out_name),
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        # Run-7 lesson: gradient_checkpointing=True + PEFT LoRA on Whisper
        # crashed loss.backward() at step 0 ("element 0 of tensors does not
        # require grad and does not have a grad_fn") - reentrant checkpointing
        # saw grad-free inputs on the encoder path. Whisper-small is 242M
        # params; fp16 activations at batch 4 cost well under the 14.56 GB T4,
        # so checkpointing stays OFF (also faster). The conv1/embedding
        # input-grad hooks above stay wired: if checkpointing is ever needed
        # for memory, re-enable together with
        # gradient_checkpointing_kwargs={"use_reentrant": False}.
        gradient_checkpointing=False,
        num_train_epochs=args.epochs,
        learning_rate=args.learning_rate,
        # T4 (Turing): fp16 AMP with fp32 base weights (autocast handles casts
        # cleanly); bf16 on the T4 is emulated and dramatically slower (run 6).
        fp16=True,
        bf16=False,
        logging_steps=args.steps_per_report,
        eval_strategy="steps",
        eval_steps=args.eval_steps,
        warmup_ratio=args.warmup_ratio,
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
        # run 6: stale config-level forced_decoder_ids conflicts with task= -
        # clear BOTH config surfaces (same treatment the eval script got).
        model.config.forced_decoder_ids = None
    except Exception as gen_err:  # noqa: BLE001
        print(f"[WARN] generation_config language could not be pinned: {gen_err}")
    # Run-6/7 pre-train smoke check: one batch, one fp16 forward AND one
    # backward under the exact conditions the Trainer will use. Run 7 passed
    # the forward but crashed at step 0 of trainer.train() during
    # loss.backward() - so the backward path is proved HERE, loudly: loss must
    # carry a grad_fn and LoRA parameters must receive gradients, otherwise
    # trainer.train() is never started.
    smoke_n = min(4, len(train_ds))
    smoke = collate([train_ds[i] for i in range(smoke_n)])
    with torch.amp.autocast("cuda", enabled=True, dtype=torch.float16):
        smoke_out = model(**{k: v.to(model.device) for k, v in smoke.items()})
    if not smoke_out.loss.requires_grad:
        hard_fail("smoke loss has no grad_fn - backward cannot reach the LoRA adapters (run-7 crash class); check the input-require-grad wiring.")
    smoke_out.loss.backward()
    grad_params = [
        name for name, p in model.named_parameters()
        if p.requires_grad and p.grad is not None and float(p.grad.abs().sum()) > 0.0
    ]
    if not grad_params:
        hard_fail("smoke backward populated NO gradients on any trainable parameter - LoRA wiring is broken; fix before trainer.train().")
    smoke_loss = float(smoke_out.loss.detach().item())
    if not torch.isfinite(torch.tensor(smoke_loss)) or smoke_loss <= 0.0:
        hard_fail(f"smoke forward produced a non-finite/non-positive loss ({smoke_loss}) - collate or labels are broken; fix BEFORE the training loop.")
    model.zero_grad(set_to_none=True)
    print(f"[SMOKE-OK] fp16 forward + backward on {smoke_n} rows, loss={smoke_loss:.4f}, grads on {len(grad_params)} trainable params")

    trainer.train()
    trainer.save_model(out_dir)
    processor.save_pretrained(out_dir)

    meta = {
        "component": "asr_whisper_lora",
        "base_model_id": args.base_model,
        "base_model_revision": args.base_model_revision,
        "lora": {"r": args.lora_r, "target_modules": lora_targets, "alpha": args.lora_r * 2},
        "model_scale": args.model_scale,
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
