#!/usr/bin/env python3
"""VoxSOAP ML - Stage 4 helper: inspect Hugging Face datasets and record gates.

Part of the Pawfolio AI feature branch implementation
(feature/voxsoap-model-integration.md §4, §7.3 stage 4).

What it does
------------
For every dataset configured below (or passed via --datasets), it:
  * resolves the CURRENT hub revision SHA for the dataset,
  * reads the dataset card metadata (license strings) as reported live,
  * discovers configs/splits/feature schema (via builders - no data download),
  * evaluates the license/permission gate for the CURRENT revision,
  * writes (or merges into) a manifest JSON that training scripts read later,
  * prints a clear SKIP message for every gated dataset so nothing is silently
    treated as training data.

The agent must never upgrade a gate by itself: use
    --record-license-decision "DATASET_ID=APPROVED"
to record a decision a human made after verifying the card themselves.

Usage (Colab or local, requires `pip install datasets huggingface_hub`):
    python inspect_datasets.py                                   # inspect all
    python inspect_datasets.py --datasets google/fleurs          # one dataset
    python inspect_datasets.py --configs google/fleurs=ur_pk,en_us
    python inspect_datasets.py --manifest-in data_manifest.json \
        --manifest-out ../reports/data_manifest_runtime.json

Exit codes: 0 = inspection ran (gated datasets are inspected, not used);
non-zero = a hard error (auth/network/infrastructure).
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import sys
from typing import Any, Dict, List, Optional

# --------------------------------------------------------------------------
# Static gate table (mirrors ml-training/data_manifest.json).
# A human reviews/changes decisions; this script only reports and records.
# --------------------------------------------------------------------------
GATES: Dict[str, Dict[str, Any]] = {
    "Tushar9802/medscribe-soap-712": {
        "expected_status": "APPROVED",
        "purpose": "SOAP formatting prototype (human medical - NOT veterinary)",
    },
    "omi-health/medical-dialogue-to-soap-summary": {
        "expected_status": "SKIP_PERMISSION_NOT_VERIFIED",
        "purpose": "Larger SOAP corpus - requires recorded permission from the original NoteChat authors",
    },
    "UmarRamzan/common-voice-urdu-processed": {
        "expected_status": "BLOCKED_LICENSE_REVIEW",
        "purpose": "Urdu ASR audio - license of the derivative must be verified first",
    },
    "google/fleurs": {
        "expected_status": "APPROVED",
        "purpose": "Licensed ASR audio for ur_pk/en_us (first smoke tests)",
    },
    "Mavkif/Roman-Urdu-Parl-split": {
        "expected_status": "APPROVED",
        "purpose": "STREAMED subsets only; separate Urdu->Roman transliteration task",
    },
    "Redgerd/roman-urdu-alpaca-qa-mix": {
        "expected_status": "APPROVED_OPTIONAL",
        "purpose": "Optional supplementary instruction data (excluded by default)",
    },
}
APPROVED_VALUES = {"APPROVED", "APPROVED_OPTIONAL"}
VALID_STATUS = APPROVED_VALUES | {"BLOCKED_LICENSE_REVIEW", "SKIP_PERMISSION_NOT_VERIFIED"}


def _utc_stamp() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def inspect_dataset(
    api: Any, dataset_id: str, config_names: Optional[List[str]]
) -> Dict[str, Any]:
    """Collect revision/license/configs/splits/fields WITHOUT downloading data."""
    from datasets import get_dataset_config_names, load_dataset_builder

    record: Dict[str, Any] = {"dataset_id": dataset_id, "inspected_at": _utc_stamp()}

    info = api.dataset_info(dataset_id)  # raises on 401/404/network - surfacing is desired
    record["hub_revision_sha"] = getattr(info, "sha", None)
    record["url"] = f"https://huggingface.co/datasets/{dataset_id}"

    card = getattr(info, "card_data", None)
    licenses = getattr(card, "license", None) if card is not None else None
    record["live_license_statement"] = licenses if isinstance(licenses, str) else str(licenses)

    try:
        names = config_names if config_names else get_dataset_config_names(dataset_id)
    except Exception as err:  # noqa: BLE001 - surfaced intentionally
        record["configs"] = {"error": f"config discovery failed: {err}"}
        names = []

    cfg_reports = []
    for cfg in names:
        cfg_report: Dict[str, Any] = {"config": cfg}
        try:
            builder = load_dataset_builder(dataset_id, cfg)
            features = builder.info.features
            cfg_report["fields"] = {k: str(v) for k, v in features.items() if features is not None}
            # Split names/ sizes without downloading rows (num_examples may be
            # None in streaming/remote mode - recorded honestly as None).
            cfg_report["splits"] = {
                s.name: (getattr(s, "num_examples", None)) for s in (builder.info.splits or {}).values()
            }
            cfg_report["builder_license"] = getattr(builder.info, "license", None)
        except Exception as err:  # noqa: BLE001
            cfg_report["error"] = f"builder inspection failed: {err}"
        cfg_reports.append(cfg_report)
    record["configs"] = cfg_reports if cfg_reports else record.get("configs", [])
    return record


def load_manifest(path: Optional[str]) -> Dict[str, Any]:
    if path and os.path.exists(path):
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    return {"manifest_version": 2, "generated_by": "inspect_datasets.py", "sources": []}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--datasets", default="all", help="comma-separated ids, or 'all'")
    parser.add_argument(
        "--configs",
        default="",
        help="dataset_id=cfg1,cfg2 overrides (may be repeated conceptually with ;)",
    )
    parser.add_argument("--manifest-in", default=None)
    parser.add_argument("--manifest-out", default="data_manifest_runtime.json")
    parser.add_argument(
        "--record-license-decision",
        default="",
        metavar="ID=STATUS",
        help="Record a HUMAN license/permission decision (e.g. "
        "'UmarRamzan/common-voice-urdu-processed=APPROVED'). The agent never "
        "authorizes a gate on its own.",
    )
    args = parser.parse_args()

    overrides: Dict[str, Dict[str, List[str]]] = {}
    for chunk in args.configs.split(";"):
        if "=" in chunk:
            ds_id, cfgs = chunk.split("=", 1)
            overrides[ds_id.strip()] = [c.strip() for c in cfgs.split(",") if c.strip()]

    decisions: Dict[str, str] = {}
    for chunk in args.record_license_decision.split(","):
        if "=" in chunk:
            ds_id, status = chunk.split("=", 1)
            if status not in VALID_STATUS:
                print(f"[GATE-ERROR] '{status}' is not a valid status {sorted(VALID_STATUS)}")
                return 2
            decisions[ds_id.strip()] = status

    try:
        from huggingface_hub import HfApi
    except ImportError:
        print("[ENV-ERROR] huggingface_hub is not installed. pip install huggingface_hub datasets")
        return 2

    selected = args.datasets.strip().lower()
    ids = list(GATES.keys()) if selected == "all" else [s.strip() for s in args.datasets.split(",") if s.strip()]

    manifest = load_manifest(args.manifest_in)
    known = {rec["dataset_id"]: rec for rec in manifest.get("sources", [])}
    failures = 0

    for ds_id in ids:
        gate = GATES.get(ds_id)
        if gate is None:
            print(f"[SKIP] {ds_id} is not part of the audited plan - refusing to inspect blindly.")
            continue
        status = decisions.get(ds_id, gate["expected_status"])
        print(f"\n=== {ds_id} ===")
        print(f"  gate: {status}")
        if status not in APPROVED_VALUES:
            print(
                f"  [SKIP-TRAINING] '{ds_id}' will NOT be used for training, model selection "
                "or release until a human decision upgrades the gate."
            )
        try:
            record = inspect_dataset(HfApi(), ds_id, overrides.get(ds_id))
        except Exception as err:  # noqa: BLE001
            print(f"  [INSPECT-FAILED] {err}")
            failures += 1
            record = {
                "dataset_id": ds_id,
                "inspected_at": _utc_stamp(),
                "error": str(err),
                "hub_revision_sha": None,
            }
        record.update(
            {
                "license_status": status,
                "license_status_decided_by": "human via CLI" if ds_id in decisions else "feature-document planning gate",
                "purpose": gate["purpose"],
                "runtime_verification": True,
            }
        )
        known[ds_id] = record

    manifest["sources"] = list(known.values())
    manifest["updated_at"] = _utc_stamp()
    os.makedirs(os.path.dirname(os.path.abspath(args.manifest_out)), exist_ok=True)
    with open(args.manifest_out, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, ensure_ascii=False)
    print(f"\n[OK] manifest written: {args.manifest_out}")
    if failures:
        print(f"[WARN] {failures} dataset(s) could not be inspected fully - check errors above.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
