"""Deterministic spoken-number normalization (2026-11-20).

ASR hears vitals as words ("twenty-four point one kilograms", "one hundred
twenty beats per minute") while the model writes digits ("24.1 kg",
"120 bpm"). Comparing those forms LITERALLY creates two opposite failures:

  * the vet_scribenote trace gate drops a TRUE spoken value because its digit
    form is not in the transcript (clinical-data loss), and
  * the clinical guard flags a TRUE spoken value as "unsupported" (false
    positive that trains operators to ignore the guard).

This module renders every maximal spoken-number run to its digit string so
both representations can be compared. It NEVER rewrites note text and NEVER
invents a number that was not spoken: an unspoken value ("24.5" when the
transcript said "24.1") still fails both checks.

Shared by providers.py (trace gate) and guards.py (fact annotations). Pure
stdlib, no model/torch imports.
"""
from __future__ import annotations

import re
from typing import List, Optional

_SPOKEN_UNITS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11,
    "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15,
    "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19,
}
_SPOKEN_TENS = {
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
    "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
}
_SPOKEN_SCALES = {"hundred": 100, "thousand": 1000}


def spoken_run_to_number(words: List[str]) -> Optional[str]:
    """Convert one maximal spoken-number run to its digit string.

    "twenty four point one" -> "24.1"; "one hundred twenty" -> "120";
    "four" -> "4". Returns None when the run has no numeric content.
    """
    if "point" in words:
        split_at = words.index("point")
        whole_words, frac_words = words[:split_at], words[split_at + 1:]
    else:
        whole_words, frac_words = words, []
    total = 0
    current = 0
    for word in whole_words:
        if word in _SPOKEN_UNITS:
            current += _SPOKEN_UNITS[word]
        elif word in _SPOKEN_TENS:
            current += _SPOKEN_TENS[word]
        elif word == "hundred":
            current = max(1, current) * 100
        elif word == "thousand":
            total += max(1, current) * 1000
            current = 0
    value = total + current
    if not frac_words:
        return str(value)
    frac_digits = "".join(
        str(_SPOKEN_UNITS[word]) for word in frac_words
        if word in _SPOKEN_UNITS and _SPOKEN_UNITS[word] < 10
    )
    return f"{value}.{frac_digits}" if frac_digits else str(value)


def spoken_number_tokens(text: str) -> List[str]:
    """Digit renderings of every spoken-number run in `text`."""
    # Strip sentence-ending periods (e.g. "five.") while keeping decimal points
    # inside literal numbers ("24.1").
    cleaned = re.sub(r"(?<!\d)\.(?!\d)", " ", (text or "").lower().replace("-", " "))
    normalized = re.sub(r"[^a-z0-9.]+", " ", cleaned)
    tokens = normalized.split()
    rendered: List[str] = []
    run: List[str] = []

    def flush() -> None:
        if run:
            value = spoken_run_to_number(run)
            if value is not None:
                rendered.append(value)
            run.clear()

    for i, token in enumerate(tokens):
        is_number = (
            token in _SPOKEN_UNITS
            or token in _SPOKEN_TENS
            or token in _SPOKEN_SCALES
            or (token == "point" and run)
        )
        if is_number:
            run.append(token)
        elif (
            run
            and token == "and"
            and i + 2 < len(tokens)
            and tokens[i + 1] == "a"
            and tokens[i + 2] == "half"
        ):
            # "three and a half" -> "3.5" (e.g. "three-and-a-half-year-old")
            whole = spoken_run_to_number(run)
            run.clear()
            if whole is not None and "." not in whole:
                rendered.append(f"{whole}.5")
        else:
            flush()
    flush()
    return rendered
