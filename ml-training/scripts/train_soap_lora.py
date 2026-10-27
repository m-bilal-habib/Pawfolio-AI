#!/usr/bin/env python3
"""VoxSOAP ML - Fine-tune the SOAP draft-generation model (Model B, §5).

QLoRA on a small instruction-following text model is the DEFAULT CANDIDATE
(the contract allows this choice to be reconsidered with hardware evidence).

Supervised objective (§5 Model B requirement):
    Loss is computed on ASSISTANT RESPONSE TOKENS ONLY. The system prompt and
    user input are masked with -100. This script FAILS CLEARLY if the chosen
    base model has no usable chat template (no silent full-prompt training
    fallback - the contract forbids copying that pattern undocumented).

Draft-safety properties carried into training:
    * target text is the source-grounded SOAP draft of the corpus,
    * under-specified sections stay explicitly short/"not stated" rather than
      being padded with invented clinical content,
    * human-medical provenance is preserved in files/manifests (never presented
      as veterinary-validated data).

Usage:
    python train_soap_lora.py \
        --train-jsonl ../data/soap/soap_train.jsonl \
        --val-jsonl   ../data/soap/soap_validation.jsonl \
        --base-model  Qwen/Qwen2.5-3B-Instruct \
        --epochs 1 --max-samples 100 --max-seq-tokens 768 \
        --export-dir ../exports/soap --out-name soap-lora-v1
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
import platform
import sys
from typing import Any, Dict, List, NoReturn, Optional

SYSTEM_PROMPT = (
    "You draft a structured SOAP note (Subjective, Objective, Assessment, Plan) "
    "strictly from the supplied consultation text. Never invent vitals, exam "
    "findings, medications, or doses that are not stated. If information is "
    "missing, leave the section short ('not stated') instead of filling it."
)


def _utc_stamp() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def hard_fail(message: str) -> NoReturn:
    print(f"[TRAIN-ABORT] {message}")
    sys.exit(3)


def check_gpu(memory_note: Optional[float] = None) -> Dict[str, Any]:
    import torch

    if not torch.cuda.is_available():
        hard_fail("No CUDA device visible. SOAP QLoRA fine-tuning requires a GPU (Colab: enable GPU runtime).")
    props = torch.cuda.get_device_properties(0)
    gpu = {"torch": torch.__version__, "device_name": props.name, "total_memory_gb": round(props.total_memory / 1024**3, 2)}
    if memory_note is not None and gpu["total_memory_gb"] < memory_note:
        hard_fail(f"GPU has {gpu['total_memory_gb']} GB; this stage wants at least {memory_note} GB.")
    return gpu


def load_jsonl(path: str, limit: Optional[int]) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    if not os.path.exists(path):
        hard_fail(f"missing prepared SOAP file: {path} (run the SOAP prep stage first)")
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            if not obj.get("input") or not obj.get("target"):
                raise ValueError("row missing input/target")
            rows.append(obj)
            if limit and len(rows) >= limit:
                break
    if not rows:
        hard_fail(f"{path} contains zero usable rows")
    print(f"[OK] loaded {len(rows)} rows from {path}")
    return rows


def build_example(tokenizer: Any, source_text: str, target_text: str,
                  max_len: Optional[int] = None) -> Optional[Dict[str, List[int]]]:
    """Tokenize one supervised example, masking the prompt.

    Implementation notes:
      * prompt_ids uses apply_chat_template(system,user, add_generation_prompt=True),
      * full_ids appends the assistant turn plus EOS,
      * the script ASSERTS that full_ids starts with prompt_ids; when the
        tokenizer's template does not guarantee that prefix property, the
        example is rejected (counted) instead of silently training on a
        misaligned mask,
      * run-6 smoke cap: when max_len is set, sequences are truncated at the
        RIGHT tail AFTER that assertion - the prompt stays fully masked with
        -100 and the assistant target is simply shortened (counted as
        'truncated', never silently corrupted).
    """
    prompt_text = tokenizer.apply_chat_template(
        [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": source_text},
        ],
        tokenize=True,
        add_generation_prompt=True,
    )
    full_text = tokenizer.apply_chat_template(
        [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": source_text},
            {"role": "assistant", "content": target_text},
        ],
        tokenize=True,
        add_generation_prompt=False,
    )
    full_text = full_text + [tokenizer.eos_token_id]
    if not prompt_text or len(full_text) <= len(prompt_text):
        return None
    if full_text[: len(prompt_text)] != prompt_text:
        return None
    labels = [-100] * len(prompt_text) + full_text[len(prompt_text):]
    truncated = False
    if max_len and len(full_text) > max_len:
        truncated = True
        # Run-6 smoke cap documented: right-tail truncation AFTER the
        # mask-prefix assertion. The prompt span stays fully masked (-100);
        # only the assistant target is shortened. Counted, never silent.
        full_text = full_text[:max_len]
        labels = labels[:max_len]
    return {"input_ids": full_text, "labels": labels, "prompt_len": len(prompt_text), "truncated": truncated}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--train-jsonl", required=True)
    parser.add_argument("--val-jsonl", required=True)
    parser.add_argument("--base-model", default="Qwen/Qwen2.5-3B-Instruct",
                        help="3B-class QLoRA candidate; verify current license/tokenizer/memory before committing (§5)")
    parser.add_argument("--base-model-revision", default="main")
    parser.add_argument("--epochs", type=float, default=1.0)
    parser.add_argument("--max-samples", type=int, default=100,
                        help="SMOKE cap (run-6): 100 rows keeps stage 12 around ~10 min on a free T4")
    parser.add_argument("--max-seq-tokens", type=int, default=768,
                        help="SMOKE runtime cap: cap chat-template token sequences at this length (right-tail truncation AFTER the mask-prefix assertion)")
    parser.add_argument("--learning-rate", type=float, default=2e-4)
    parser.add_argument("--batch-size", type=int, default=2)
    parser.add_argument("--grad-accum", type=int, default=4)
    parser.add_argument("--lora-r", type=int, default=16)
    parser.add_argument("--export-dir", default="../exports/soap")
    parser.add_argument("--out-name", default="soap-lora-v1")
    parser.add_argument("--model-scale", choices=["smoke", "full"], default="smoke",
                        help="honest scale tag recorded in the training manifest; serving surfaces it in every response")
    args = parser.parse_args()

    print("[ENV] checking GPU...")
    gpu = check_gpu(memory_note=14.0)
    print(f"[GPU] {gpu}")

    import torch
    from transformers import AutoTokenizer, Trainer, TrainingArguments
    from peft import LoraConfig
    try:
        import bitsandbytes  # noqa: F401 - required for QLoRA 4-bit quantization
    except ImportError:
        hard_fail("bitsandbytes is not installed (required for QLoRA). pip install bitsandbytes==0.49.2")

    train_rows = load_jsonl(args.train_jsonl, args.max_samples)
    val_rows = load_jsonl(args.val_jsonl, max(16, args.max_samples // 10))

    tokenizer = AutoTokenizer.from_pretrained(args.base_model, revision=args.base_model_revision)
    if not getattr(tokenizer, "chat_template", None):
        hard_fail(
            f"'{args.base_model}' has no chat template. Loss masking on assistant tokens "
            "cannot be guaranteed with a silent fallback - pick an instruct base with a "
            "chat template or set a reviewed template explicitly."
        )

    train_examples: List[Dict[str, Any]] = []
    rejected = 0
    truncated_long = 0
    prompts_total = 0
    for row in train_rows:
        example = build_example(tokenizer, row["input"], row["target"], args.max_seq_tokens)
        if example is None:
            rejected += 1
            continue
        train_examples.append(example)
        truncated_long += int(example["truncated"])
        prompts_total += example["prompt_len"]
    if not train_examples:
        hard_fail("No training example passed the mask-prefix assertion - tokenizer template mismatch.")
    val_examples = [e for e in (build_example(tokenizer, r["input"], r["target"], args.max_seq_tokens)
                                 for r in val_rows) if e]
    print(f"[MASK] assistant-only labels over {len(train_examples)} examples; "
          f"{rejected} rejected on template-prefix mismatch; "
          f"{truncated_long} truncated at --max-seq-tokens {args.max_seq_tokens}; "
          f"{prompts_total} prompt tokens masked to -100")

    def collate(batch: List[Dict[str, Any]]):
        maxlen = max(len(ex["input_ids"]) for ex in batch)
        pad_id = tokenizer.pad_token_id or tokenizer.eos_token_id
        input_ids, labels, attention = [], [], []
        for ex in batch:
            pad = maxlen - len(ex["input_ids"])
            # LEFT-pad so the LAST tokens are the assistant content: labels use
            # -100 for pad tokens AND for the masked prompt span.
            input_ids.append([pad_id] * pad + ex["input_ids"])
            labels.append([-100] * pad + ex["labels"])
            attention.append([0] * pad + [1] * len(ex["input_ids"]))
        return {
            "input_ids": torch.tensor(input_ids, dtype=torch.long),
            "labels": torch.tensor(labels, dtype=torch.long),
            "attention_mask": torch.tensor(attention, dtype=torch.long),
        }

    # Summarize the masked-objective decision in the trainer log (contract §5).
    from transformers import AutoModelForCausalLM, BitsAndBytesConfig
    # T4 (Turing) has NO bf16 tensor cores - `is_bf16_supported()` still
    # reports True and the code fell back to slow bf16 emulation, which made
    # the 200-row smoke epoch take ~49 minutes (run 5). Force fp16: bf16
    # compute + fp16 AMP is the verified fast path on the free-Colab T4.
    compute_dtype = torch.float16
    quant_config_bnb = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=compute_dtype,
        bnb_4bit_use_double_quant=True,
    )
    model = AutoModelForCausalLM.from_pretrained(
        args.base_model,
        revision=args.base_model_revision,
        quantization_config=quant_config_bnb,
        device_map="auto",
    )
    model.config.use_cache = False

    lora_cfg = LoraConfig(
        r=args.lora_r, lora_alpha=args.lora_r * 2, lora_dropout=0.05, bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
    )
    from peft import get_peft_model, prepare_model_for_kbit_training
    model = prepare_model_for_kbit_training(model)
    model = get_peft_model(model, lora_cfg)
    model.print_trainable_parameters()

    targs = TrainingArguments(
        output_dir=os.path.join("../checkpoints", args.out_name),
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        num_train_epochs=args.epochs,
        learning_rate=args.learning_rate,
        logging_steps=10,
        eval_strategy="steps",
        eval_steps=50,
        save_total_limit=2,
        # T4 (Turing): fp16 AMP only. The old `bf16=is_bf16_supported()` line
        # resolved to bf16=True on the T4 and made the smoke epoch 6x slower.
        fp16=True,
        bf16=False,
        report_to=[],
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
    )

    # Trainer computes CE from batch['labels'] - the -100 mask IS the
    # assistant-only objective (no loss on system/user prompt tokens).
    trainer = Trainer(model=model, args=targs, train_dataset=train_examples,
                      eval_dataset=val_examples, data_collator=collate)
    trainer.train()

    out_dir = os.path.join(args.export_dir, args.out_name)
    os.makedirs(out_dir, exist_ok=True)
    trainer.save_model(out_dir)  # saves ONLY the adapter (PEFT) - base stays external
    tokenizer.save_pretrained(out_dir)
    meta = {
        "component": "soap_draft_lora_qlora",
        "base_model_id": args.base_model,
        "base_model_revision": args.base_model_revision,
        "objective": "supervised SFT; loss on assistant tokens only (prompt masked with -100)",
        "training_source": "Tushar9802/medscribe-soap-712 (human medical - NOT veterinary-validated)",
        "quantization": {
            "load_in_4bit": True,
            "bnb_4bit_quant_type": "nf4",
            "bnb_4bit_compute_dtype": str(compute_dtype),
            "bnb_4bit_use_double_quant": True,
        },
        "lora": {"r": args.lora_r, "target_modules": ["q_proj", "k_proj", "v_proj", "o_proj"]},
        "model_scale": args.model_scale,
        "train_rows": len(train_examples),
        "val_rows": len(val_examples),
        "mask_rejected_rows": rejected,
        "gpu": gpu,
        "python_platform": platform.platform(),
        "trained_at": _utc_stamp(),
        "adapter_path": out_dir,
        "note": "Adapter is NOT a complete model: serving must load this WITH the exact base checkpoint id+revision.",
        "executed": True,
    }
    with open(os.path.join(out_dir, "training_manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(meta, handle, indent=2)
    print(f"[DONE] adapter + tokenizer + manifest -> {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
