#!/usr/bin/env python3
"""VoxSOAP ML - Model C: Roman Urdu transliteration LoRA training (§5 Model C, §4.5).

SEPARATE text-to-text task (contract: "Roman Urdu normalization remains a
separate optional experiment", §12.1). Never bundled into Whisper, never
claimed as an ASR capability.

Input files are the Stage-14 prepared pairs (urdu/roman fields, clean caps,
official splits preserved). mT5-small + LoRA is the DEFAULT CANDIDATE so the
experiment stays single-GPU/Colab-viable; the contract allows reconsidering
with hardware evidence.

Dtype decision (run-9 remediation): PURE fp32. The mT5/T5 family is
officially not tested with fp16, and the run-9 adapter collapsed under the
previous fp32-masters + fp16-AMP recipe at lr 5e-4 to emitting ONLY the
span-corruption sentinel '<extra_id_0>' (exact_match 0.0, CER 0.9142, all 20
review rows sentinel-only - see reports/run9_artifacts_verification_*.md).
mt5-small trains comfortably in fp32 on the T4, so no AMP is used.

Usage:
    python train_transliteration_lora.py \
        --train-jsonl ../data/roman_urdu/roman_urdu_train.jsonl \
        --val-jsonl   ../data/roman_urdu/roman_urdu_validation.jsonl \
        --base-model google/mt5-small \
        --epochs 3 --max-samples 2000 --lora-r 16 \
        --export-dir ../exports/roman --out-name roman-lora-v1
"""
from __future__ import annotations

# Run-5 lesson (BEFORE any transformers import anywhere in this process):
import os as _boot_os

_boot_os.environ.setdefault("USE_TF", "0")
_boot_os.environ.setdefault("USE_FLAX", "0")

import argparse
import datetime as _dt
import json
import os
import platform
import sys
from typing import Any, Dict, List, NoReturn

# Task prefix makes the intent explicit for T5-style enc-dec (kept stable with
# evaluate_transliteration.py - the EXACT SAME prefix must be used in serving).
TASK_PREFIX = "transliterate to roman urdu: "

# mt5 span-corruption alignment (run-11): every mt5 pretraining decoder
# sequence starts "<pad> <extra_id_0> ...", so the first generated token has an
# overwhelming <extra_id_0> prior baked into the base model. Run-10 proved that
# LoRA (3 epochs, fp32, lr 1e-4) cannot fight it: train loss stalled at
# ~ln(vocab_size)=12.43 (near-uniform over the 250k vocab) with every probe
# prediction sentinel-headed. Instead of fighting, ALIGN: targets are prefixed
# with the sentinel (matching mt5's own pretraining output format) and decoded
# text is stripped of sentinels downstream (evaluate_transliteration.py and
# serving whisper/roman decode use the same convention).
TARGET_PREFIX = "<extra_id_0>"


def _strip_leading_sentinels(text: str) -> str:
    parts = text.split()
    while parts and parts[0].startswith("<extra_id_"):
        parts.pop(0)
    return " ".join(parts).strip()


def _utc_stamp() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def hard_fail(message: str) -> NoReturn:
    print(f"[HARD-FAIL] {message}")
    sys.exit(2)


def check_gpu(memory_note: float = 10.0) -> Dict[str, Any]:
    import torch

    if not torch.cuda.is_available():
        hard_fail("No CUDA device visible - Model C LoRA training requires the Colab T4 (contract §7.1.3).")
    props = torch.cuda.get_device_properties(0)
    total_gb = props.total_memory / (1024 ** 3)
    if total_gb < memory_note:
        print(f"[WARN] GPU memory {total_gb:.2f} GB < advised {memory_note} GB - continuing with honest warning.")
    return {
        "cuda": True,
        "torch": torch.__version__,
        "device_name": props.name,
        "total_memory_gb": round(total_gb, 2),
    }


def load_jsonl(path: str, max_rows: int) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            if max_rows and len(rows) >= max_rows:
                break
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if str(rec.get("urdu", "")).strip() and str(rec.get("roman", "")).strip():
                rows.append(rec)
    if not rows:
        hard_fail(f"{path} contains zero usable urdu/roman pairs")
    print(f"[OK] loaded {len(rows)} pairs from {path}")
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--train-jsonl", required=True)
    parser.add_argument("--val-jsonl", required=True)
    parser.add_argument("--base-model", default="google/mt5-small")
    parser.add_argument("--base-model-revision", default="main")
    parser.add_argument("--epochs", type=float, default=3.0)
    parser.add_argument("--max-samples", type=int, default=2000,
                        help="train cap; notebook passes CONFIG_KNOBS['ROMAN_URDU_TRAIN']")
    parser.add_argument("--max-val-samples", type=int, default=300)
    parser.add_argument("--learning-rate", type=float, default=1e-4,
                        help="run-10 remediation: 5e-4 under fp16-AMP collapsed to sentinel output in run 9")
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--grad-accum", type=int, default=2)
    parser.add_argument("--lora-r", type=int, default=16)
    parser.add_argument("--lora-targets", default="q,k,v,o",
                        help="T5 attention module names; run-11: q,k,v,o (run-10 used only q,v)")
    parser.add_argument("--max-source-tokens", type=int, default=128)
    parser.add_argument("--max-target-tokens", type=int, default=128)
    parser.add_argument("--steps-per-report", type=int, default=25)
    parser.add_argument("--eval-steps", type=int, default=50,
                        help="earlier eval points than run-9's 125 so a collapse is visible in logs")
    parser.add_argument("--model-scale", choices=["smoke", "full"], default="smoke",
                        help="honest scale tag recorded in the training manifest")
    parser.add_argument("--export-dir", default="../exports/roman")
    parser.add_argument("--out-name", default="roman-lora-v1")
    args = parser.parse_args()

    print("[ENV] checking GPU...")
    gpu = check_gpu()
    print(f"[GPU] {gpu}")

    import torch
    from transformers import AutoTokenizer, Seq2SeqTrainer, Seq2SeqTrainingArguments
    from transformers import AutoModelForSeq2SeqLM
    from peft import LoraConfig, get_peft_model

    train_rows = load_jsonl(args.train_jsonl, args.max_samples)
    val_rows = load_jsonl(args.val_jsonl, args.max_val_samples)

    tokenizer = AutoTokenizer.from_pretrained(args.base_model, revision=args.base_model_revision, use_fast=True)

    # The whole run-11 remediation hangs on '<extra_id_0>' being ONE real token.
    sent_ids = tokenizer(TARGET_PREFIX, add_special_tokens=False).input_ids
    if len(sent_ids) != 1:
        hard_fail(f"target prefix '{TARGET_PREFIX}' must tokenize to exactly one id; got {sent_ids}")

    inputs_ids: List[List[int]] = []
    labels_ids: List[List[int]] = []
    skipped = 0
    for rec in train_rows:
        src = tokenizer(TASK_PREFIX + rec["urdu"], truncation=True, max_length=args.max_source_tokens).input_ids
        tgt = tokenizer(TARGET_PREFIX + " " + rec["roman"], truncation=True, max_length=args.max_target_tokens).input_ids
        if not src or not tgt:
            skipped += 1
            continue
        inputs_ids.append(src)
        labels_ids.append(tgt)
    if not inputs_ids:
        hard_fail("No usable training pairs after tokenization.")
    print(f"[OK] tokenized {len(inputs_ids)} train pairs ({skipped} skipped empty after tokenization)")

    def collate(batch: List[Dict[str, Any]]):
        input_rows = [{"input_ids": b["input_ids"]} for b in batch]
        label_rows = [{"input_ids": b["labels"]} for b in batch]
        padded = tokenizer.pad(input_rows, padding=True, return_tensors="pt")
        lab = tokenizer.pad(label_rows, padding=True, return_tensors="pt")["input_ids"]
        # -100 on pad positions so CE ignores them (mt5 pad id 0 is a real token)
        lab = lab.masked_fill(lab == tokenizer.pad_token_id, -100)
        return {
            "input_ids": padded["input_ids"],
            "attention_mask": padded["attention_mask"],
            "labels": lab,
        }

    train_ds = [{"input_ids": s, "labels": t} for s, t in zip(inputs_ids, labels_ids)]
    val_ds = [
        {
            "input_ids": tokenizer(TASK_PREFIX + r["urdu"], truncation=True, max_length=args.max_source_tokens).input_ids,
            "labels": tokenizer(TARGET_PREFIX + " " + r["roman"], truncation=True, max_length=args.max_target_tokens).input_ids,
        }
        for r in val_rows
        if tokenizer(TASK_PREFIX + r["urdu"]).input_ids and tokenizer(r["roman"]).input_ids
    ]

    # PURE fp32 (run-9 collapse evidence; rationale in module docstring).
    model = AutoModelForSeq2SeqLM.from_pretrained(args.base_model, revision=args.base_model_revision)
    model.config.use_cache = False

    # T5/mt5 attention modules are named q/k/v/o as plain Linear layers;
    # run-11 widens LoRA from [q, v] to all four attention planes for capacity.
    lora_targets = [s.strip() for s in args.lora_targets.split(",") if s.strip()]
    lora_cfg = LoraConfig(
        r=args.lora_r, lora_alpha=args.lora_r * 2, lora_dropout=0.05,
        target_modules=lora_targets, bias="none",
    )
    model = get_peft_model(model, lora_cfg)
    model.print_trainable_parameters()

    # Pre-train smoke check: ONE fp32 forward + backward, grads proven on
    # LoRA params (same loud pre-loop proof as the ASR/SOAP scripts).
    smoke_n = min(4, len(train_ds))
    smoke = collate(train_ds[:smoke_n])
    smoke_out = model(**{k: v.to(model.device) for k, v in smoke.items()})
    if not smoke_out.loss.requires_grad:
        hard_fail("smoke loss has no grad_fn - LoRA wiring is broken.")
    smoke_out.loss.backward()
    grad_params = [
        name for name, p in model.named_parameters()
        if p.requires_grad and p.grad is not None and float(p.grad.abs().sum()) > 0.0
    ]
    if not grad_params:
        hard_fail("smoke backward populated NO gradients on any trainable parameter.")
    smoke_loss = float(smoke_out.loss.detach().item())
    if smoke_loss != smoke_loss or smoke_loss == float("inf") or smoke_loss == float("-inf") or smoke_loss <= 0.0:
        hard_fail(f"smoke forward produced a non-finite/non-positive loss ({smoke_loss}).")
    model.zero_grad(set_to_none=True)
    print(f"[SMOKE-OK] fp32 forward + backward on {smoke_n} pairs, loss={smoke_loss:.4f}, grads on {len(grad_params)} trainable params")

    targs = Seq2SeqTrainingArguments(
        output_dir=os.path.join("../checkpoints", args.out_name),
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        # T5-family guard: keep reentrant checkpointing OFF with PEFT (run-7
        # class of failure); activations are affordable for mt5-small.
        gradient_checkpointing=False,
        num_train_epochs=args.epochs,
        learning_rate=args.learning_rate,
        # run-9 remediation: PURE fp32 for the T5/mt5 family - the fp16-AMP
        # variant collapsed to '<extra_id_0>' sentinel output (docstring has
        # the evidence trail). mt5-small fp32 fits and computes on the T4.
        fp16=False,
        bf16=False,
        logging_steps=args.steps_per_report,
        eval_strategy="steps",
        eval_steps=args.eval_steps,
        warmup_ratio=0.05,
        save_total_limit=2,
        remove_unused_columns=False,
        predict_with_generate=False,
        report_to=[],
    )

    trainer = Seq2SeqTrainer(
        model=model, args=targs, train_dataset=train_ds, eval_dataset=val_ds,
        data_collator=collate, compute_metrics=None,
    )
    trainer.train()

    # Run-9 lesson: an adapter that emits ONLY span-corruption sentinels is
    # useless yet run-9 exported one silently (its own eval also ran before
    # training finished, per the packaged timestamps). Probe IMMEDIATELY after
    # training and record it in the manifest. The adapter is still saved for
    # diagnostics, but a collapsed result is loudly flagged and serving must
    # not be pointed at it.
    model.eval()
    probe_results = []
    probe_collapsed = True
    for rec in val_rows[:3]:
        ids = tokenizer(TASK_PREFIX + str(rec["urdu"]), return_tensors="pt",
                        truncation=True, max_length=args.max_source_tokens).input_ids.to(model.device)
        with torch.no_grad():
            out = model.generate(input_ids=ids, max_new_tokens=64, num_beams=1, do_sample=False)
        raw = tokenizer.batch_decode(out, skip_special_tokens=True)[0].strip()
        pred = _strip_leading_sentinels(raw)
        probe_results.append({"expected": str(rec["roman"])[:120], "generated_raw": raw[:140], "generated": pred[:120]})
        if pred:
            probe_collapsed = False
    print(f"[QUALITY-PROBE] collapsed={probe_collapsed}: {json.dumps(probe_results)[:1500]}")
    if probe_collapsed:
        print("[WARN][QUALITY-PROBE] EVERY probe prediction is empty after stripping the leading span-corruption "
              "sentinels - the adapter learned nothing usable. Saved for diagnostics ONLY; serving must NOT point "
              "at this adapter.")

    out_dir = os.path.join(args.export_dir, args.out_name)
    os.makedirs(out_dir, exist_ok=True)
    trainer.save_model(out_dir)
    tokenizer.save_pretrained(out_dir)
    meta = {
        "component": "roman_urdu_transliteration_lora",
        "base_model_id": args.base_model,
        "base_model_revision": args.base_model_revision,
        "objective": "seq2seq transliteration urdu->roman; task prefix recorded in TASK_PREFIX",
        "task_prefix": TASK_PREFIX,
        "training_source": "Mavkif/Roman-Urdu-Parl-split (Apache-2.0; parliamentary text, NOT veterinary speech)",
        "lora": {"r": args.lora_r, "target_modules": lora_targets, "alpha": args.lora_r * 2},
        "model_scale": args.model_scale,
        "target_prefix": TARGET_PREFIX,
        "target_prefix_note": "aligned with mt5 span-corruption pretraining format; decoded text is stripped of leading sentinels downstream (evaluator + serving).",
        "dtype": "fp32",
        "train_rows": len(inputs_ids),
        "val_rows": len(val_ds),
        "gpu": gpu,
        "python_platform": platform.platform(),
        "trained_at": _utc_stamp(),
        "adapter_path": out_dir,
        "note": "Adapter is NOT a complete model: serving must pair it with the exact base checkpoint id+revision.",
        "quality_probe": {"collapsed": probe_collapsed, "probe": probe_results},
        "executed": True,
    }
    with open(os.path.join(out_dir, "training_manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(meta, handle, indent=2)
    print(f"[DONE] adapter + tokenizer + manifest -> {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
