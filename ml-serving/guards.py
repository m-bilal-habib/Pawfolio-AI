"""VoxSOAP ML serving - deterministic clinical guard annotations.

Ported from ml-training/scripts/evaluate_soap.py (§11.3 deterministic checks):
NUMBER_RE / MED_TOKEN_RE / UNSTATED_MARKERS / section-presence / fact-set
arithmetic are the SAME rules, applied at serving time to annotate every
/draft response with honest, purely mechanical observations.

2026-11-20 correction (spoken-number parity): ASR writes vitals as words
("twenty-four point one kilograms", "one hundred twenty beats per minute")
while the model writes digits ("24.1 kg", "120 bpm"). The original literal
comparison flagged those TRUE spoken values as "unsupported" (false positives
that also made the trace gate look broken). Number sets are now compared
symmetrically through `spoken_numbers.spoken_number_tokens`, and unit tokens
accept their spelled-out form ("kg" vs "kilograms"). This only removes false
positives: an unspoken value ("24.5" against a spoken "24.1") still shows up as
unsupported.

THIS IS NOT A CLINICAL-SAFETY VERDICT. It can flag suspicious facts; it can
never certify correctness. The contract is explicit: the vet remains the
reviewer of record, and the UI must surface the draft as an editable draft.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List

from spoken_numbers import spoken_number_tokens

SECTION_LABELS = ("SUBJECTIVE", "OBJECTIVE", "ASSESSMENT", "PLAN")
NUMBER_RE = re.compile(r"\d+(?:[.,]\d+)?")
MED_TOKEN_RE = re.compile(
    r"\b(mg|ml|mcg|kg|g|tablet|tablets|drops|capsule|capsules|syrup|injection|"
    r"once daily|twice daily|three times daily)\b",
    re.IGNORECASE,
)
# Same tuple as evaluate_soap.py's UNTREATED_MARKERS.
UNSTATED_MARKERS = ("not stated", "not mentioned", "no information", "not documented", "not provided")

# Unit abbreviations accept their spelled-out transcript form: ASR hears
# "kilograms"/"milligrams", the model writes "kg"/"mg".
_UNIT_SPELLINGS = {
    "kg": ("kilogram", "kilograms", "kilo", "kilos"),
    "g": ("gram", "grams"),
    "mg": ("milligram", "milligrams"),
    "mcg": ("microgram", "micrograms"),
    "ml": ("milliliter", "milliliters", "millilitre", "millilitres"),
}


def _number_set(text: str) -> set:
    """Literal digits plus spoken-number digit renderings (symmetric)."""
    return set(NUMBER_RE.findall(text)) | set(spoken_number_tokens(text))


def _med_set(text: str) -> set:
    """Med/unit tokens, canonicalized so spelled-out units match abbreviations."""
    tokens = {tok.lower() for tok in MED_TOKEN_RE.findall(text)}
    lower = text.lower()
    for unit, spellings in _UNIT_SPELLINGS.items():
        if any(spelling in lower for spelling in spellings):
            tokens.add(unit)
    return tokens


def sections_present(draft: str) -> Dict[str, bool]:
    upper = str(draft or "").upper()
    return {label: upper.find(label) >= 0 for label in SECTION_LABELS}


def fact_sets(source: str, draft: str) -> Dict[str, List[str]]:
    return {
        "numbers_src": sorted(_number_set(source)),
        "numbers_draft": sorted(_number_set(draft)),
        "meds_src": sorted(_med_set(source)),
        "meds_draft": sorted(_med_set(draft)),
    }


def clinical_guard(draft: str, source_text: str) -> Dict[str, Any]:
    """Deterministic annotations for an /draft response - NEVER a verdict."""
    draft = str(draft or "")
    source_text = str(source_text or "")
    sections = sections_present(draft)
    facts = fact_sets(source_text, draft)
    unsupported_numbers = sorted(set(facts["numbers_draft"]) - set(facts["numbers_src"]))
    unsupported_meds = sorted(set(facts["meds_draft"]) - set(facts["meds_src"]))
    omitted_numbers = sorted(set(facts["numbers_src"]) - set(facts["numbers_draft"]))
    omitted_meds = sorted(set(facts["meds_src"]) - set(facts["meds_draft"]))
    lower = draft.lower()
    return {
        "schema": {
            "sections_present": sections,
            "complete_schema": all(sections.values()),
        },
        "facts": {
            "unsupported_numbers_in_draft": unsupported_numbers,
            "unsupported_med_tokens_in_draft": unsupported_meds,
            "numbers_from_source_missing_in_draft": omitted_numbers,
            "med_tokens_from_source_missing_in_draft": omitted_meds,
        },
        "unstated_markers_used_in_draft": [m for m in UNSTATED_MARKERS if m in lower],
        "review_hint": (
            "deterministic annotations only - this is NOT a clinical-safety verdict; "
            "the veterinarian remains the reviewer of record"
        ),
    }
