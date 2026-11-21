#!/usr/bin/env python3
"""VoxSOAP ML - Roman Urdu transliteration data preparation (Model C, §5/§8.1).

Builds SEPARATE text pairs for the Urdu-script -> Roman-Urdu normalization
task from `Mavkif/Roman-Urdu-Parl-split` (Apache-2.0, ~6.33M rows - MUST be
streamed, never fully loaded). The pairs stay in their own files: they are
never mixed with ASR labels or SOAP data, and no fake aligned audio pairs are
ever fabricated from unrelated text.

Optional (default OFF): `Redgerd/roman-urdu-alpaca-qa-mix` instruction data is
written to its own file with `experiment: optional_textnormalization` so its
contribution stays separable and reportable.

Usage:
    python prepare_roman_urdu_data.py \
        --out-dir ../data/roman_urdu \
        --max-per-split 2000 --max-val-rows 300 --max-test-rows 300 --seed 20260124 \
        [--include-alpaca]
Writes: roman_urdu_train.jsonl / _validation.jsonl / _test.jsonl,
optionally alpaca_optional.jsonl, plus roman_urdu_prep_report.json.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import os
import random
import re
import sys
import time
from difflib import SequenceMatcher
from typing import Any, Dict, List, Optional, Tuple

DATASET_PARL = "Mavkif/Roman-Urdu-Parl-split"
DATASET_ALPACA = "Redgerd/roman-urdu-alpaca-qa-mix"
NEAR_DUP_SIMILARITY = 0.96
NEAR_CACHE_MAX = 4096
OFFICIAL_SPLITS = ("train", "validation", "test")

MIN_CHARS, MAX_CHARS = 6, 2_000


def _utc_stamp() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def normalize_text(text: str) -> str:
    """Whitespace-only normalization (keeps Urdu script, punctuation intact)."""
    return re.sub(r"\s+", " ", str(text or "")).strip()


def stable_row_id(dataset_id: str, split: str, row: Dict[str, Any], fields: Tuple[str, str]) -> str:
    joined = "|".join(str(row.get(f, "")) for f in fields)
    digest = hashlib.sha256(f"{dataset_id}|{split}|{joined}".encode("utf-8")).hexdigest()
    return digest[:16]


def discover_pair_fields(sample: Dict[str, Any]) -> Optional[Tuple[str, str]]:
    """Locate (lang_field, target_field) from a REAL example.

    'lang_field' (renamed lang_e17 in some exports) holds the Urdu text in this
    dataset's documented layout, but this function trusts the data, not names:
    it picks the two text columns whose values differ and whose non-empty
    rates look like a parallel pair.
    """
    text_cols: List[str] = []
    for key, value in sample.items():
        if isinstance(value, str) and value.strip():
            if not re.search(r"^\d+(\.\d+)?$", value.strip()):
                text_cols.append(key)
    text_cols = text_cols[:4]  # first textual columns only; order is stable in CSV
    if len(text_cols) < 2:
        return None
    (a, b) = text_cols[0], text_cols[1]
    # lang_e17 documented as the Urdu column; confirm the VALUES differ.
    if a.lower() == "lang_e17" and sample.get(a) != sample.get(b):
        return a, b
    if normalize_text(sample.get(a, "")) == normalize_text(sample.get(b, "")):
        return None
    return a, b


def contains_urdu_script(text: str) -> bool:
    """Arabic-script detection (Urdu block) - guards the source column."""
    return bool(re.search(r"[\u0600-\u06FF]", text))


def contains_roman(text: str) -> bool:
    return bool(re.search(r"[A-Za-z]", text))


def process_split(dataset_id: str, split: str, fields: Tuple[str, str], cap: int,
                  seen_hashes: set, near_cache: List[str], rng: random.Random,
                  counters: Dict[str, Any]) -> List[Dict[str, Any]]:
    from datasets import load_dataset

    accepted: List[Dict[str, Any]] = []
    rejected: Dict[str, int] = {}
    stream = load_dataset(dataset_id, split=split, streaming=True)
    if cap:
        stream = stream.shuffle(seed=rng.randint(0, 2**31 - 1), buffer_size=2048)
    taken = 0
    for row in stream:
        if cap and taken >= cap:
            break
        try:
            urdu_raw, roman_raw = row.get(fields[0]), row.get(fields[1])
            if not isinstance(urdu_raw, str) or not isinstance(roman_raw, str):
                raise ValueError("fields missing")
            urdu, roman = normalize_text(urdu_raw), normalize_text(roman_raw)
            if not urdu or not roman:
                raise ValueError("empty member")
            if len(urdu) < MIN_CHARS or len(roman) < MIN_CHARS:
                raise ValueError("too short")
            if len(urdu) > MAX_CHARS or len(roman) > MAX_CHARS:
                raise ValueError("too long")
            if not contains_urdu_script(urdu):
                raise ValueError("source is not Urdu script")
            if not contains_roman(roman):
                raise ValueError("target is not Roman text")
            pair_digest = hashlib.sha256(f"{urdu}\n@@ROMAN@@\n{roman}".encode("utf-8")).hexdigest()
            if pair_digest in seen_hashes:
                raise ValueError("exact duplicate")
            joined = f"{urdu}|{roman}"
            near_hit = False
            for seen in near_cache:
                # Run-11 speed fix (same rejection semantics, measured honestly
                # in the report): an O(n*m) difflib ratio per (row x cache)
                # pair took ~32 min for 2.2k rows. difflib ratio is bounded by
                # 2*min/(len_a+len_b), so if that provable bound cannot reach
                # the threshold, a FULL scan is pointless and skipped.
                if 2 * min(len(joined), len(seen)) / NEAR_DUP_SIMILARITY < len(joined) + len(seen):
                    continue
                if SequenceMatcher(None, joined, seen).ratio() >= NEAR_DUP_SIMILARITY:
                    near_hit = True
                    break
            if near_hit:
                raise ValueError("near duplicate")
            urdu_clean = urdu
            roman_clean = roman
        except ValueError as reason:
            rejected[str(reason)] = rejected.get(str(reason), 0) + 1
            continue
        seen_hashes.add(pair_digest)
        if len(near_cache) < NEAR_CACHE_MAX:
            near_cache.append(joined)
        accepted.append(
            {
                "urdu": urdu_clean,
                "roman": roman_clean,
                "source_dataset": dataset_id,
                "source_split": split,
                "source_row_id": stable_row_id(dataset_id, split, row, fields),
                "task": "transliteration_normalization",
            }
        )
        taken += 1
    counters["Accepted"][split] = len(accepted)
    counters["Rejected"].update(rejected)
    return accepted


def process_alpaca(cap: int, rng: random.Random) -> List[Dict[str, Any]]:
    """Optional instruction mix - KEPT SEPARATE from the paired corpus."""
    from datasets import load_dataset

    stream = load_dataset(DATASET_ALPACA, split="train", streaming=True).shuffle(
        seed=rng.randint(0, 2**31 - 1), buffer_size=1024
    )
    out: List[Dict[str, Any]] = []
    for row in stream:
        if cap and len(out) >= cap:
            break
        instruction = normalize_text(str(row.get("instruction", "")))
        inp = normalize_text(str(row.get("input", "")))
        output = normalize_text(str(row.get("output", "")))
        if not instruction or not output:
            continue
        out.append(
            {
                "instruction": instruction,
                "input": inp if inp and inp.lower() != "nan" else "",
                "output": output,
                "source_dataset": DATASET_ALPACA,
                "source_split": "train",
                "task": "optional_textnormalization_instruction",
            }
        )
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--out-dir", default="../data/roman_urdu")
    parser.add_argument("--max-per-split", type=int, default=300)
    parser.add_argument("--max-val-rows", type=int, default=300,
                        help="validation cap; run-10/11 fix: was silently clamped to 120 inside the script")
    parser.add_argument("--max-test-rows", type=int, default=300,
                        help="test cap; run-11 fix: the notebook used to hardcode 80")
    parser.add_argument("--alpaca-cap", type=int, default=200)
    parser.add_argument("--seed", type=int, default=20260124)
    parser.add_argument("--include-alpaca", action="store_true")
    args = parser.parse_args()

    manifest: Optional[Dict[str, Any]] = None
    manifest_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data_manifest.json")
    if os.path.exists(manifest_path):
        with open(manifest_path, "r", encoding="utf-8") as handle:
            try:
                manifest = json.load(handle)
            except json.JSONDecodeError:
                manifest = None
    status = next(
        (
            s.get("license_status")
            for s in (manifest or {}).get("sources", [])
            if s.get("dataset_id") == DATASET_PARL
        ),
        None,
    )
    if status not in (None, "APPROVED", "APPROVED_OPTIONAL"):
        print(f"[GATE-SKIP] {DATASET_PARL} status is {status} - not used until a human upgrades the gate.")
        return 3

    from datasets import load_dataset

    counters: Dict[str, Any] = {"Accepted": {}, "Rejected": {}}
    probe = next(iter(load_dataset(DATASET_PARL, split="train", streaming=True)), None)
    if probe is None:
        print("[DATA-ERROR] could not read a single record from the parliament corpus.")
        return 2
    fields = discover_pair_fields(probe)
    if fields is None:
        print(f"[DATA-ERROR] no parallel pair discovered. Sample keys: {list(probe.keys())}")
        return 2
    print(f"[DISCOVER] urdu='{fields[0]}' roman='{fields[1]}' (verified from record values, not names)")

    rng = random.Random(args.seed)
    seen_hashes: set = set()
    near_cache: List[str] = []
    caps = {"train": args.max_per_split, "validation": args.max_val_rows, "test": args.max_test_rows}
    os.makedirs(args.out_dir, exist_ok=True)
    outputs: Dict[str, Any] = {}
    split_seconds: Dict[str, float] = {}
    for split in OFFICIAL_SPLITS:
        t0 = time.perf_counter()
        rows = process_split(DATASET_PARL, split, fields, caps[split], seen_hashes, near_cache, rng, counters)
        split_seconds[split] = round(time.perf_counter() - t0, 2)
        path = os.path.join(args.out_dir, f"roman_urdu_{split}.jsonl")
        with open(path, "w", encoding="utf-8") as handle:
            for r in rows:
                handle.write(json.dumps(r, ensure_ascii=False) + "\n")
        outputs[f"{path}"] = {"rows": len(rows)}
        print(f"[OK] {split}: {len(rows)} rows -> {path}")

    if args.include_alpaca:
        rows = process_alpaca(args.alpaca_cap, rng)
        path = os.path.join(args.out_dir, "alpaca_optional.jsonl")
        with open(path, "w", encoding="utf-8") as handle:
            for r in rows:
                handle.write(json.dumps(r, ensure_ascii=False) + "\n")
        outputs[f"{path}"] = {"rows": len(rows), "note": "separate experiment file - never merged into the parallel corpus"}
        print(f"[OK] alpaca optional experiment: {len(rows)} rows -> {path}")

    report = {
        "dataset_id": DATASET_PARL,
        "optional_alpaca_included": bool(args.include_alpaca),
        "discovered_fields": {"urdu": fields[0], "roman": fields[1]},
        "accepted": counters["Accepted"],
        "rejected": counters["Rejected"],
        "caps": caps,
        "seed": args.seed,
        "split_policy": "official splits preserved; streaming subsets only (full CSV never materialized)",
        "dedup_scan": "exact-dup via global hash; near-dup via difflib ratio gated by a PROVABLY-safe length bound (2*min/thr < len_a+len_b skips the scan) - threshold and rejection semantics unchanged",
        "split_seconds": split_seconds,
        "generated_at": _utc_stamp(),
        "outputs": outputs,
        "executed": True,
    }
    with open(os.path.join(args.out_dir, "roman_urdu_prep_report.json"), "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    print(f"[OK] report -> {os.path.join(args.out_dir, 'roman_urdu_prep_report.json')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
