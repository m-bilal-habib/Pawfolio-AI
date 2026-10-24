#!/usr/bin/env python3
"""VoxSOAP ML - SOAP draft evaluation (§11.3) - deterministic checks + review sheet.

Automated measures (deliberately NOT a clinical-safety verdict, and never a
substitute for human review):
  * section presence / schema shape rate (S, O, A, P labeled blocks),
  * supported-fact retention  - reference facts (numbers, med names, doses)
    that also appear in the draft,
  * unsupported/hallucinated candidates - numbers or med tokens in the DRAFT
    that are NOT in the source text,
  * omitted facts - numbers/med tokens in the SOURCE missing from the draft,
  * undocumented-vs-negative handling: presence of explicit 'not stated'
    markers is counted (renderer-level honesty signal).
Plus a CSV review sheet (stable case ids, empty reviewer columns) for the
mandated manual scoring (§11.3 vet reviewer rows).

Usage:
    python evaluate_soap.py \
        --cases ../data/soap/soap_test.jsonl \
        --drafts ../exports/soap/soap_test_drafts.jsonl \
        --report ../reports/soap_eval.json \
        --review-sheet ../reports/soap_review_sheet.csv
Drafts file rows: {"source_row_id": ..., "draft_text": ...} - produced by the
notebook generation stage. Missing cases are reported, never fabricated.
"""
from __future__ import annotations

import argparse
import csv
import datetime as _dt
import json
import os
import re
import sys
from typing import Any, Dict, List

SECTION_LABELS = ("SUBJECTIVE", "OBJECTIVE", "ASSESSMENT", "PLAN")
NUMBER_RE = re.compile(r"\d+(?:[.,]\d+)?")
MED_TOKEN_RE = re.compile(r"\b(mg|ml|mcg|kg|g|tablet|tablets|drops|capsule|capsules|syrup|injection|once daily|twice daily|three times daily)\b", re.IGNORECASE)
UNTREATED_MARKERS = ("not stated", "not mentioned", "no information", "not documented", "not provided")


def _utc_stamp() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_jsonl(path: str) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    if not os.path.exists(path):
        print(f"[EVAL-SKIP] missing file: {path}")
        sys.exit(2)
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def sections_present(draft: str) -> Dict[str, bool]:
    upper = draft.upper()
    return {label: upper.find(label) >= 0 for label in SECTION_LABELS}


def fact_sets(source: str, draft: str) -> Dict[str, List[str]]:
    numbers_src = set(NUMBER_RE.findall(source))
    numbers_draft = set(NUMBER_RE.findall(draft))
    meds_src = {tok.lower() for tok in MED_TOKEN_RE.findall(source)}
    meds_draft = {tok.lower() for tok in MED_TOKEN_RE.findall(draft)}
    return {
        "numbers_src": sorted(numbers_src),
        "numbers_draft": sorted(numbers_draft),
        "meds_src": sorted(meds_src),
        "meds_draft": sorted(meds_draft),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--cases", required=True, help="test JSONL from SOAP prep (input/target/source_row_id)")
    parser.add_argument("--drafts", required=True, help="generation output: {source_row_id, draft_text}")
    parser.add_argument("--report", default="../reports/soap_eval.json")
    parser.add_argument("--review-sheet", default="../reports/soap_review_sheet.csv")
    parser.add_argument("--max-cases", type=int, default=60)
    args = parser.parse_args()

    cases = load_jsonl(args.cases)[: args.max_cases]
    drafts = {row.get("source_row_id"): row.get("draft_text") for row in load_jsonl(args.drafts)}

    if not cases:
        print("[EVAL-SKIP] the test case pack is empty.")
        sys.exit(2)

    per_case: List[Dict[str, Any]] = []
    agg: Dict[str, Any] = {
        "schema_ok": 0,
        "unsupported_fact_cases": 0,
        "omitted_fact_cases": 0,
        "missing_drafts": 0,
    }

    for case in cases:
        row_id = str(case.get("source_row_id") or "")
        draft = drafts.get(row_id)
        if not draft:
            agg["missing_drafts"] += 1
            per_case.append({"case_id": row_id, "state": "MISSING_DRAFT"})
            continue
        sections = sections_present(draft)
        facts = fact_sets(str(case.get("input", "")), str(draft))
        unsupported = sorted(set(facts["numbers_draft"]) - set(facts["numbers_src"]))
        retained = sorted(set(facts["numbers_src"]) & set(facts["numbers_draft"]))
        omitted = sorted(set(facts["numbers_src"]) - set(facts["numbers_draft"]))
        meds_retained = sorted(set(facts["meds_src"]) & set(facts["meds_draft"]))
        meds_omitted = sorted(set(facts["meds_src"]) - set(facts["meds_draft"]))
        schema_ok = sections["SUBJECTIVE"] and sections["OBJECTIVE"] and sections["ASSESSMENT"] and sections["PLAN"]
        agg["schema_ok"] += int(schema_ok)
        if unsupported:
            agg["unsupported_fact_cases"] += 1
        if omitted or meds_omitted:
            agg["omitted_fact_cases"] += 1
        per_case.append(
            {
                "case_id": row_id,
                "state": "EVALUATED",
                "sections": sections,
                "schema_ok": schema_ok,
                "unsupported_facts": unsupported,
                "retained_facts": retained,
                "omitted_facts": omitted,
                "meds_retained": meds_retained,
                "meds_omitted": meds_omitted,
                "explicit_untreated_markers": [m for m in UNTREATED_MARKERS if m in draft.lower()],
                "draft_chars": len(draft),
            }
        )

    evaluated = [c for c in per_case if c["state"] == "EVALUATED"]
    n = max(len(evaluated), 1)
    report: Dict[str, Any] = {
        "evaluated_component": "soap_draft",
        "n_cases": len(cases),
        "n_evaluated": len(evaluated),
        "missing_drafts": agg["missing_drafts"],
        "schema_ok_rate": round(agg["schema_ok"] / n, 4),
        "cases_with_unsupported_facts": agg["unsupported_fact_cases"],
        "cases_with_omitted_facts": agg["omitted_fact_cases"],
        "measured_at": _utc_stamp(),
        "executed": True,
        "limitation": (
            "Token-based automated signals ONLY. Clinical safety verdicts require the "
            "veterinarian-reviewed benchmark (§8.3) and human scoring; ROUGE/BLEU or "
            "second-LLM judgment alone is explicitly insufficient (§11.3)."
        ),
        "per_case": per_case,
    }
    print(json.dumps({k: v for k, v in report.items() if k != "per_case"}, indent=2))

    if args.report:
        os.makedirs(os.path.dirname(os.path.abspath(args.report)), exist_ok=True)
        with open(args.report, "w", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2, ensure_ascii=False)
        print(f"[OK] metrics -> {args.report}")

    if args.review_sheet:
        os.makedirs(os.path.dirname(os.path.abspath(args.review_sheet)), exist_ok=True)
        with open(args.review_sheet, "w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(
                [
                    "case_id", "reviewer (BLANK - fill manually)", "supported_facts_0to5",
                    "unsupported_claims_0to5", "med_dose_fidelity_0to5",
                    "omission_serious_0to5", "usefulness_0to5", "edit_effort_minutes",
                    "notes (free text)",
                ]
            )
            for case in evaluated:
                writer.writerow([case["case_id"], "", "", "", "", "", "", "", ""])
        print(f"[OK] reviewer sheet (empty scoring columns) -> {args.review_sheet}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
