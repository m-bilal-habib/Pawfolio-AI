#!/usr/bin/env python3
"""VoxSOAP ML - SOAP dataset preparation (feature/voxsoap-model-integration.md §8).

Streams the approved SOAP source and writes a normalized intermediate format:

    {"input": "...", "target": "...",
     "source_dataset": "...", "source_split": "...", "source_row_id": "..."}

Hard rules enforced here:
  * The permission-gated `omi-health/medical-dialogue-to-soap-summary` is
    REFUSED unless the owner has upgraded its gate in the manifest.
  * Actual field names are DISCOVERED from real records - never assumed.
  * Official train/validation/test partitions are respected (no random re-split
    and never merging the test split into training data).
  * Quality checks per §8.2 with accepted/rejected counters and reasons.
  * Deterministic seeds; a bounded cap per split keeps first runs small.

Usage (after Stage 4 wrote the runtime manifest):
    python prepare_soap_data.py \
        --dataset Tushar9802/medscribe-soap-712 \
        --manifest ../data_manifest.json \
        --out-dir ../data/soap \
        --max-per-split 200 --max-test-rows 60 --seed 20260124
Outputs: soap_train.jsonl / soap_validation.jsonl / soap_test.jsonl and
soap_prep_report.json (counts, rejected reasons, dedupe stats).
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
from difflib import SequenceMatcher
from typing import Any, Dict, Iterable, List, Optional, Tuple

DEFAULT_DATASET = "Tushar9802/medscribe-soap-712"
# Conservative, configurable quality limits (§8.2 - "configurable limits").
DEFAULT_MIN_CHARS, DEFAULT_MAX_CHARS = 40, 14_000
NEAR_DUP_SIMILARITY = 0.96  # exact and near-duplicate detection threshold
NEAR_CACHE_MAX = 4096

# Set in main(): configurable limits shared by quality_gate (avoid passing
# argparse state through every helper signature).
MIN_CHARS, MAX_CHARS = DEFAULT_MIN_CHARS, DEFAULT_MAX_CHARS

OFFICIAL_SPLITS = ("train", "validation", "test")


def _utc_stamp() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def normalize_text(text: str) -> str:
    """Whitespace normalization that never strips meaningful characters."""
    return re.sub(r"\s+", " ", str(text or "")).strip()


def stable_row_id(dataset_id: str, split: str, row: Dict[str, Any], fields: Optional[Tuple[str, str]]) -> str:
    """Deterministic, non-sensitive row identifier for the manifest."""
    if fields is not None:
        joined = "|".join(str(row.get(f, "")) for f in fields)
    else:
        # chat format: hash the serialized message structure (no raw text reuse)
        joined = json.dumps(row.get("messages"), ensure_ascii=False, default=str)[:2048]
    digest = hashlib.sha256(f"{dataset_id}|{split}|{joined}".encode("utf-8")).hexdigest()
    return digest[:16]


def flatten_content(content: Any) -> str:
    """Chat `content` may be a plain string or a list of typed parts."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: List[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                text = item.get("text", item.get("content", ""))
                if isinstance(text, str):
                    parts.append(text)
        return "\n".join(parts)
    return str(content or "")


def extract_chat_pair(messages: Any) -> Optional[Tuple[str, str]]:
    """Map a chat-style example to (user-turn input, assistant-turn target).

    The MedScribe corpus exposes ONLY a `messages` column (observed live in the
    2026-10-24 smoke run: keys == ['messages']). Standard layout is a list of
    {role, content} items; user turns become the encounter text and assistant
    turns become the SOAP draft. Missing halves reject the row explicitly.
    """
    if messages is None or not isinstance(messages, list):
        return None
    user_parts: List[str] = []
    assistant_parts: List[str] = []
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role", "")).lower()
        content = flatten_content(msg.get("content", "")).strip()
        if not content:
            continue
        if role == "user":
            user_parts.append(content)
        elif role == "assistant":
            assistant_parts.append(content)
    if not user_parts or not assistant_parts:
        return None
    return "\n".join(user_parts).strip(), "\n".join(assistant_parts).strip()


def is_chat_messages_produce(probe: Dict[str, Any]) -> bool:
    msgs = probe.get("messages")
    return isinstance(msgs, list) and len(msgs) > 0


def discover_fields(sample: Dict[str, Any]) -> Optional[Tuple[str, str]]:
    """Find (input_field, target_field) from a REAL example, never by name only."""
    keys = list(sample.keys())
    long_text = [
        k for k in keys
        if isinstance(sample[k], str) and len(sample[k].strip()) >= DEFAULT_MIN_CHARS
    ]
    long_text.sort(key=lambda k: -len(sample[k]))
    if len(long_text) < 2:
        return None
    # Longest field tends to be the source encounter; the structured-but-long
    # counterpart is the SOAP target. Record both ids in the report for review.
    return long_text[0], long_text[1]


def quality_gate(text: str, split: str, counters: Dict[str, int]) -> bool:
    """Configurable §8.2 limits; REJECTED rows are counted with a reason."""
    if not text or len(text.strip()) < MIN_CHARS:
        key = "rejected_empty_or_too_short"
        counters[key] = counters.get(key, 0) + 1
        return False
    if len(text) > MAX_CHARS:
        key = f"rejected_too_long_{split}"
        counters[key] = counters.get(key, 0) + 1
        return False
    return True


def process_split(
    dataset_id: str,
    split: str,
    chat_mode: bool,
    fields: Optional[Tuple[str, str]],
    caps: Dict[str, int],
    seen_hashes: set,
    rng: random.Random,
    counters: Dict[str, Any],
) -> List[Dict[str, Any]]:
    from datasets import load_dataset  # streaming support confirmed for this source

    accepted: List[Dict[str, Any]] = []
    split_counters: Dict[str, int] = {}
    # Shuffle BEFORE take when subsetting streamed data (§7.2); respect official
    # splits and caps so validation/test never leak into training.
    stream: Iterable[Any] = load_dataset(dataset_id, split=split, streaming=True)
    if caps.get(split):
        stream = stream.shuffle(seed=rng.randint(0, 2**31 - 1), buffer_size=1024)

    taken = 0
    for row in stream:
        if caps.get(split) and taken >= caps[split]:
            break
        try:
            if chat_mode:
                pair = extract_chat_pair(row.get("messages"))
                if pair is None:
                    raise ValueError("chat row missing user/assistant halves")
                src_text, tgt_text = normalize_text(pair[0]), normalize_text(pair[1])
            else:
                raw_in, raw_tgt = row.get((fields or ("input", "target"))[0]), row.get((fields or ("input", "target"))[1])
                if not isinstance(raw_in, str) or not isinstance(raw_tgt, str):
                    raise ValueError("fields missing or non-text")
                src_text, tgt_text = normalize_text(raw_in), normalize_text(raw_tgt)
            pair = f"{src_text}\n@@SOAP@@\n{tgt_text}"
            digest = hashlib.sha256(pair.encode("utf-8")).hexdigest()
            if digest in seen_hashes:
                raise ValueError("exact duplicate")
            near = any(
                SequenceMatcher(None, pair, seen).ratio() >= NEAR_DUP_SIMILARITY
                for seen in near_cache
            )
            if near:
                raise ValueError("near duplicate >= %.2f" % NEAR_DUP_SIMILARITY)
            if not quality_gate(src_text, split, split_counters) or not quality_gate(tgt_text, split, split_counters):
                raise ValueError("quality gate")
        except ValueError as reason:
            counters["Rejected"][str(reason)] = counters["Rejected"].get(str(reason), 0) + 1
            continue
        seen_hashes.add(digest)
        if len(near_cache) < NEAR_CACHE_MAX:
            near_cache.append(pair)
        accepted.append(
            {
                "input": src_text,
                "target": tgt_text,
                "source_dataset": dataset_id,
                "source_split": split,
                "source_row_id": stable_row_id(dataset_id, split, row, fields),
            }
        )
        taken += 1
    counters["Accepted"][split] = len(accepted)
    counters["Rejected"].update(split_counters)
    return accepted


def gate_refuses(dataset_id: str, manifest: Optional[Dict[str, Any]]) -> Optional[str]:
    if dataset_id == "omi-health/medical-dialogue-to-soap-summary":
        status = None
        if manifest:
            status = next((s.get("license_status") for s in manifest.get("sources", []) if s.get("dataset_id") == dataset_id), None)
        if status != "APPROVED":
            return (
                "[GATE-SKIP] omi-health/medical-dialogue-to-soap-summary is "
                "SKIP_PERMISSION_NOT_VERIFIED - not used for training/selection/release "
                "until the owner records permission from the original NoteChat authors."
            )
    return None


def main() -> int:
    global near_cache, MIN_CHARS, MAX_CHARS
    near_cache = []
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--dataset", default=DEFAULT_DATASET)
    parser.add_argument("--manifest", default=None, help="runtime manifest produced by Stage 4")
    parser.add_argument("--out-dir", default="../data/soap")
    parser.add_argument("--max-per-split", type=int, default=200, help="cap for train/validation")
    parser.add_argument("--max-test-rows", type=int, default=60)
    parser.add_argument("--min-chars", type=int, default=DEFAULT_MIN_CHARS)
    parser.add_argument("--max-chars", type=int, default=DEFAULT_MAX_CHARS)
    parser.add_argument("--seed", type=int, default=20260124)
    args = parser.parse_args()

    MIN_CHARS, MAX_CHARS = args.min_chars, args.max_chars

    manifest = None
    if args.manifest and os.path.exists(args.manifest):
        with open(args.manifest, "r", encoding="utf-8") as handle:
            manifest = json.load(handle)

    refusal = gate_refuses(args.dataset, manifest)
    if refusal:
        print(refusal)
        return 3

    from datasets import load_dataset

    counters: Dict[str, Any] = {"Accepted": {}, "Rejected": {}}
    print(f"[DISCOVER] sampling one real record of {args.dataset} to discover fields...")
    probe = next(iter(load_dataset(args.dataset, split="train", streaming=True)), None)
    if probe is None:
        print("[DATA-ERROR] could not read a single record - verify dataset id/split.")
        return 2

    if is_chat_messages_produce(probe):
        # MedScribe exposes ONLY a 'messages' column (seen live 2026-10-24).
        chat_mode = True
        first_pair = extract_chat_pair(probe.get("messages"))
        if first_pair is None:
            preview = [
                f"role={m.get('role')},content_type={type(m.get('content')).__name__}"
                for m in probe.get("messages", [])
                if isinstance(m, dict)
            ]
            print(f"[DATA-ERROR] 'messages' rows lack a trainable user+assistant pair. Roles seen: {preview}")
            print("[DATA-ERROR] paste this preview to the agent to extend the mapping before training.")
            return 2
        discovered = {
            "format": "chat_messages",
            "input": "messages[user turns joined]",
            "target": "messages[assistant turns joined]",
        }
        print(f"[DISCOVER] chat-format OK; roles={[m.get('role') for m in probe['messages'] if isinstance(m, dict)]}")
        print(f"[DISCOVER] user preview: {first_pair[0][:140]!r}")
        print(f"[DISCOVER] assistant (SOAP) preview: {first_pair[1][:140]!r}")
        fields = None
    else:
        chat_mode = False
        fields = discover_fields(probe)
        if fields is None:
            print(f"[DATA-ERROR] no input/target text fields discovered. Keys: {list(probe.keys())}")
            return 2
        discovered = {"format": "text_columns", "input": fields[0], "target": fields[1]}
        print(f"[DISCOVER] mapping input='{fields[0]}' target='{fields[1]}' - verify with a sample below")
        print(json.dumps({k: str(probe[k])[:160] for k in probe}, ensure_ascii=False, indent=2))

    rng = random.Random(args.seed)
    seen_hashes: set = set()
    caps = {
        "train": args.max_per_split,
        "validation": min(args.max_per_split, 100),
        "test": args.max_test_rows,
    }
    written = {}
    for split in OFFICIAL_SPLITS:
        rows = process_split(args.dataset, split, chat_mode, fields, caps, seen_hashes, rng, counters)
        path = os.path.join(args.out_dir, f"soap_{split}.jsonl")
        os.makedirs(args.out_dir, exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            for r in rows:
                handle.write(json.dumps(r, ensure_ascii=False) + "\n")
        written[split] = {"path": path, "rows": len(rows)}
        print(f"[OK] {split}: {len(rows)} rows -> {path}")

    report = {
        "dataset_id": args.dataset,
        "discovered_fields": discovered,
        "accepted": counters["Accepted"],
        "rejected": counters["Rejected"],
        "caps": caps,
        "seed": args.seed,
        "split_policy": "official dataset splits preserved; test never merged into training",
        "dedupe": {"exact": True, "near_similarity_threshold": NEAR_DUP_SIMILARITY},
        "generated_at": _utc_stamp(),
        "outputs": written,
        "executed": True,
    }
    with open(os.path.join(args.out_dir, "soap_prep_report.json"), "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    print(f"[OK] report -> {os.path.join(args.out_dir, 'soap_prep_report.json')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
