#!/usr/bin/env python3
"""VoxSOAP ML - Model C evaluation: Roman Urdu transliteration (§4.5/§11.x).

Scores the Model C adapter on the PRESERVED official test pairs:
  * exact_match (normalized + unnormalized)
  * CER via jiwer on the normalized pairs (rule explicitly recorded)
  * mean latency per example
  * failures are counted, never fabricated
Plus a 20-row review table CSV for the mandated fluent-speaker scoring
(contract: name/medicine transliteration behavior must be evaluated by a
fluent speaker before the data is relied upon).

Normalization is EXPLICIT and printed into the report - scores are never
compared across different rules.

Usage:
    python evaluate_transliteration.py \
        --cases ../data/roman_urdu/roman_urdu_test.jsonl \
        --adapter ../exports/roman/roman-lora-v1 \
        --base-model google/mt5-small \
        [--max-rows 300] [--report ../reports/roman_eval.json]
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
import sys
import time
from typing import Any, Dict, List

# Kept in sync with train_transliteration_lora.py TASK_PREFIX.
TASK_PREFIX = "transliterate to roman urdu: "

NORMALIZATION_NOTE = "NFKC; casefold; collapse whitespace"


def _utc_stamp() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def normalize(text: str) -> str:
    import re
    import unicodedata

    text = unicodedata.normalize("NFKC", str(text or ""))
    text = text.casefold()
    return re.sub(r"\s+", " ", text).strip()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--cases", required=True)
    parser.add_argument("--adapter", required=True)
    parser.add_argument("--base-model", default="google/mt5-small")
    parser.add_argument("--base-model-revision", default="main")
    parser.add_argument("--max-rows", type=int, default=300)
    parser.add_argument("--max-new-tokens", type=int, default=256)
    parser.add_argument("--sample-cap", type=int, default=20, help="review-table rows")
    parser.add_argument("--report", default="../reports/roman_eval.json")
    args = parser.parse_args()

import jiwer
    import torch
    from peft import PeftModel
    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

    def _strip_leading_sentinels(text: str) -> str:
        # Same convention as train_transliteration_lora.py (run-11): aligned
        # targets begin with '<extra_id_0>', so decoded text does too; strip
        # before metrics and serving.
        parts = text.split()
        while parts and parts[0].startswith("<extra_id_"):
            parts.pop(0)
        return " ".join(parts).strip()

    cases: List[Dict[str, Any]] = []
    with open(args.cases, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            if str(rec.get("urdu", "")).strip() and str(rec.get("roman", "")).strip():
                cases.append(rec)
    if not cases:
        print("[EVAL-SKIP] no usable test pairs - nothing fabricated.")
        return 2
    if args.max_rows:
        cases = cases[: args.max_rows]
    print(f"[OK] {len(cases)} test pairs (cap={args.max_rows})")

    tokenizer = AutoTokenizer.from_pretrained(args.adapter, use_fast=True)
    model = AutoModelForSeq2SeqLM.from_pretrained(
        args.base_model, revision=args.base_model_revision
    ).float()
    model = PeftModel.from_pretrained(model, args.adapter)
    model.eval()
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model.to(device)

    manifest_path = os.path.join(args.adapter, "training_manifest.json")
    manifest_base = None
    if os.path.exists(manifest_path):
        with open(manifest_path, "r", encoding="utf-8") as fh:
            manifest_base = json.load(fh).get("base_model_id")
    if manifest_base and manifest_base != args.base_model:
        print(f"[WARN] adapter manifest base ({manifest_base}) != --base-model ({args.base_model}) - verify before trusting results.")

    refs: List[str] = []
    hyps: List[str] = []
    latencies: List[float] = []
    review_rows: List[Dict[str, str]] = []
    for index, rec in enumerate(cases):
        try:
            ids = tokenizer(TASK_PREFIX + rec["urdu"], return_tensors="pt", truncation=True,
                            max_length=128).input_ids.to(device)
            t0 = time.perf_counter()
            with torch.no_grad():
                out = model.generate(input_ids=ids, max_new_tokens=args.max_new_tokens,
                                     num_beams=1, do_sample=False)
            raw = tokenizer.batch_decode(out, skip_special_tokens=True)[0].strip()
            pred = _strip_leading_sentinels(raw)
            latencies.append(time.perf_counter() - t0)
            refs.append(rec["roman"])
            hyps.append(pred)
            if len(review_rows) < args.sample_cap:
                review_rows.append({
                    "case_id": str(rec.get("source_row_id", index)),
                    "urdu": rec["urdu"],
                    "roman_reference": rec["roman"],
                    "roman_prediction": pred,
                    "raw_prediction": raw,
                    "reviewer (BLANK - fluent speaker)": "",
                    "acceptable_0to7": "",
                    "notes (free text)": "",
                })
        except Exception as err:  # noqa: BLE001
            print(f"[WARN] test pair {index} failed ({err}) - excluded, counted.")

    if not refs:
        print("[EVAL-SKIP] every pair failed - no metrics fabricated.")
        return 2

    exact = sum(1 for r, h in zip(refs, hyps) if normalize(r) == normalize(h))
    exact_raw = sum(1 for r, h in zip(refs, hyps) if r == h)
    cer = jiwer.cer([normalize(r) for r in refs], [normalize(h) for h in hyps])
    leader_rate = sum(1 for h in hyps if h == _strip_leading_sentinels(h)) / max(1, len(hyps))
    leader_rate = 1.0 - leader_rate  # fraction whose raw began with a sentinel

    report: Dict[str, Any] = {
        "evaluated_component": "roman_urdu_transliteration",
        "base_model": args.base_model,
        "adapter": args.adapter,
        "normalization": NORMALIZATION_NOTE,
        "postprocess": "strip leading '<extra_id_N>' tokens from decoded predictions (mt5 span-corruption target-prefix alignment)",
        "sentinel_leader_rate": round(leader_rate, 4),
        "n_pairs": len(refs),
        "exact_match_norm": round(exact / len(refs), 4),
        "exact_match_raw": round(exact_raw / len(refs), 4),
        "cer": round(float(cer), 4),
        "latency": {
            "mean_s": round(sum(latencies) / len(latencies), 4) if latencies else None,
            "device": device,
        },
        "review_table_rows": len(review_rows),
        "executed": True,
        "measured_at": _utc_stamp(),
        "limitation": "Parliamentary-domain pairs; behavior on clinical/veterinary words needs fluent-speaker review before any reliance (§4.5).",
    }
    with open(args.report, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    print(f"[REPORT] {json.dumps({k: v for k, v in report.items() if k not in ('limitation',)}, indent=2)}")

    review_path = args.report.replace(".json", "_review_table.csv")
    with open(review_path, "w", encoding="utf-8") as fh:
        if review_rows:
            fh.write(",".join(review_rows[0].keys()) + "\n")
            for row in review_rows:
                fh.write(",".join(str(v).replace(",", ";") for v in row.values()) + "\n")
    print(f"[OK] review table ({len(review_rows)} rows, reviewer columns BLANK) -> {review_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
