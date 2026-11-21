"""VoxSOAP ML serving providers (Phase 4 scaffold).

Design rules taken directly from the feature contract and the run 1-8 lessons:

* Adapter-not-a-model compatibility: every LoRA adapter directory MUST carry
  a training_manifest.json whose base_model_id/revision matches the
  configured base checkpoint. Serving REFUSES to load a mismatch - pairing an
  adapter with the wrong base would produce plausible-looking garbage.
* Lazy loading: importing this module (and starting uvicorn) must NOT import
  torch or load any weights. Weights load on the first request that needs
  them and can be dropped again with unload() - the Windows RAM safeguard for
  the unquantized 3B-class SOAP base (bitsandbytes 4-bit is Linux-only).
* Provider isolation: ML and Gemini-proxy providers never substitute for each
  other. A failed ML call raises InferenceError and the API layer turns it
  into a controlled 5xx. The Gemini provider is used only when the REQUEST
  explicitly selects provider="gemini" (or VOXSOAP_DEFAULT_PROVIDER=gemini).
* model_scale: every response carries a scale label with an explicit source,
  never fabricated (see resolve_scale).
"""
from __future__ import annotations

# Run-5 lesson: set the transformers guard env BEFORE any transformers import.
# All transformers imports here are lazy (inside loaders), but the guard must
# already be set for whichever module triggers the first import.
import os as _boot_os

_boot_os.environ.setdefault("USE_TF", "0")
_boot_os.environ.setdefault("USE_FLAX", "0")

import base64
import copy
import gc
import json
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from spoken_numbers import spoken_number_tokens
from vet_glossary import (
    build_whisper_initial_prompt,
    clean_asr_transcript,
    resolve_drug_name,
)

# Kept in byte-for-byte sync with train_transliteration_lora.py and
# evaluate_transliteration.py (the EXACT same prefix must be used in serving).
TASK_PREFIX = "transliterate to roman urdu: "

COMPONENT_KEYS = ("asr", "soap", "roman")

# Owner budget fix (2026-11-05): on CPU EVERY draft releases the resident
# fp32 Whisper (~1.2 GB) BEFORE the bf16 3B SOAP model loads/generates. The
# 2026-11-04/05 drills on the owner 16 GB box showed free physical RAM at
# 1.1-2.5 GB during drafts (Chrome + dev server + IDE resident) and the same
# 448-token draft stretching ~470 s -> ~1,100 s under paging; unconditional
# release takes the cold-load RAM peak off the table entirely (the panel has
# already finished transcribing by then; the next /transcribe reloads Whisper
# on demand - one cold Whisper load per draft-then-transcribe round trip).
# Opt-out: VOXSOAP_ASR_RELEASE_BEFORE_DRAFT=0 keeps the conditional-2.0-GB-era
# behaviour of leaving Whisper resident across drafts. Introspection or
# unload failures NEVER break inference.
try:
    _ASR_RELEASE_BEFORE_DRAFT = (
        _boot_os.environ.get("VOXSOAP_ASR_RELEASE_BEFORE_DRAFT", "1").strip() != "0"
    )
except Exception:
    _ASR_RELEASE_BEFORE_DRAFT = True

# ---- Vet Scribenote contract (owner Fix 2, 2026-11-01) ----------------------
# The medscribe soap-lora adapter forces SHORT human-medical summaries and
# building a 23-parameter objective by generating "Not mentioned" 21 times
# burns ~150 CPU tokens. The default /draft format ("vet_scribenote")
# therefore runs the BASE Qwen weights (adapter disabled) with a strict
# veterinary prompt: the model only states parameters the transcript
# EXPLICITLY contains, and Python post-processing deterministically hydrates
# all 23 canonical parameters (missing -> "Not mentioned").

VET_NOTE_FORMAT = "vet_scribenote"
VET_NOTE_FORMATS = ("vet_scribenote", "medscribe")

# Canonical physical-exam parameters, EXACT owner order (never re-sorted).
VET_OBJECTIVE_PARAMS: Tuple[str, ...] = (
    "Temperature",
    "Heart Rate",
    "Weight",
    "Respiratory Rate",
    "Capillary Refill Time",
    "Mucous Membranes",
    "Hydration Status",
    "Body Condition Score",
    "Pain Score",
    "Fear Anxiety Stress Score",
    "Eyes",
    "Ears",
    "Nasal",
    "Oral/Dental",
    "Cardiovascular",
    "Respiratory",
    "Neurological",
    "Musculoskeletal",
    "Lymphatic",
    "Gastrointestinal",
    "Reproductive/Urinary",
    "Integument",
    "Masses",
)

VET_NOT_MENTIONED = "Not mentioned"

# Model-emitted non-data placeholders (wrong: line should not exist at all)
# map deterministically onto the canonical "Not mentioned" hydration. A value
# is kept ONLY when it carries actual spoken data — any of these placeholder
# tokens as the WHOLE value means "not documented in the transcript".
_VET_PLACEHOLDER_VALUES = (
    "not examined",
    "not noted",
    "not stated",
    "not documented",
    "not mentioned",
    "not evaluated",
    "not assessed",
    "not performed",
    "not recorded",
    "not checked",
    "unremarkable",
    "unspecified",
    "no abnormality",
    "no abnormality detected",
    "no findings",
    "no data",
    "nad",
    "wnl",
    "n/a",
    "na",
    "none",
    "normal",
    "within normal limits",
)


def _vet_value_or_not_mentioned(value: str) -> str:
    """Deterministic placeholder collapse: a bare non-data token ("Normal",
    "WNL", "not examined", ...) hydrates to "Not mentioned"; a spoken value
    with real content survives verbatim."""
    v = re.sub(r"\s+", " ", value or "").strip()
    if not v:
        return VET_NOT_MENTIONED
    norm = re.sub(r"[^a-z0-9/]", "", v.lower())
    if norm in {re.sub(r"[^a-z0-9/]", "", p) for p in _VET_PLACEHOLDER_VALUES}:
        return VET_NOT_MENTIONED
    return v


# ---- objective-value trace gate (owner no-hallucination doctrine) -----------
# 2026-11-03 live probe: even with the hardened prompt the base-3B model
# states unstated parameters ("Mucous Membranes: pink and moist"). The same
# rule the frontend verifyGroundedClaims (FR-27) enforces applies here:
# UNTRACEABLE claims are DROPPED (never rewritten). A stated objective VALUE
# survives only when EVERY meaningful token has a verbatim trace in the
# consultation transcript (`transcript` is always available in the serving
# path); otherwise it deterministically hydrates to "Not mentioned" and is
# counted for the honesty note. Units and copulas are stopwords (they carry
# no finding; "kg"/"bpm" must not gate a value the transcript phrases as
# "kilograms"). Numbers are kept dotful ("24.5" must match "24.5").
_VET_TRACE_STOPWORDS = frozenset({
    "a", "an", "the", "and", "or", "of", "in", "to", "with", "for", "on",
    "is", "are", "was", "were", "be", "at", "by", "as", "it", "its",
    "no", "not", "very", "both", "s", "kg", "lbs", "bpm", "f", "c", "mm",
})


def _vet_norm_trace(value: str) -> str:
    return re.sub(r"[^a-z0-9.]+", " ", (value or "").lower()).strip()


def _vet_value_traced(value: str, transcript_norm: str) -> bool:
    tokens = [
        token for token in _vet_norm_trace(value).split()
        if token and token not in _VET_TRACE_STOPWORDS
    ]
    if not tokens or not transcript_norm:
        return False
    return all(token in transcript_norm for token in tokens)


def _vet_spoken_number_tokens(text: str) -> List[str]:
    """Digit renderings of every spoken-number run in `text` (trace corpus).

    Thin alias kept for the tests and call sites; the implementation is
    shared with guards.py via spoken_numbers.py (2026-11-20).
    """
    return spoken_number_tokens(text)


VET_SCRIBENOTE_SYSTEM_PROMPT = (
    "You are a veterinary medical scribe. Output ONE COMPACT minified single-line JSON object ONLY "
    "(no markdown, no indentation, omit null or empty fields/arrays) strictly grounded in the transcript.\n"
    "Schema:\n"
    '{"subjective":{"clinical_summary":"Concise 3rd-person history preserving negations verbatim (e.g. no vomiting, normal appetite — NEVER invert polarity)","appetite":"...","water_intake":"...","vomiting_diarrhea":"...","duration":"...","known_allergies":"..."},'
    '"objective":{"Weight":"...","Temperature":"..."},'
    '"assessment":["short diagnosis/differential/vaccination bullet ONLY — do NOT put medications here"],'
    '"plan":{"medications":[{"spoken_name":"COPY EXACT spoken drug name verbatim — NEVER substitute or invent another drug","dose":"...","route":"...","frequency":"...","duration":"..."}],'
    '"vaccines_administered":["..."],"diagnostics":["..."],"procedures":["..."],"home_care":["..."],"follow_up":"..."}}\n'
    "RULES:\n"
    "1. SPARSE OBJECTIVE ONLY: include ONLY canonical keys EXPLICITLY measured or examined: Temperature, Heart Rate, Weight, Respiratory Rate, Capillary Refill Time, Mucous Membranes, Hydration Status, Body Condition Score, Pain Score, Fear Anxiety Stress Score, Eyes, Ears, Nasal, Oral/Dental, Cardiovascular, Respiratory, Neurological, Musculoskeletal, Lymphatic, Gastrointestinal, Reproductive/Urinary, Integument, Masses.\n"
    "2. NEVER emit 'Not mentioned', 'Not examined', 'Normal', 'WNL', or 'N/A'; OMIT unexamined or explicitly skipped vitals (e.g. skipped temperature).\n"
    "3. Capture EVERY spoken exam system finding (Cardiovascular, Respiratory, Gastrointestinal, Lymphatic, etc.) concisely using words/numbers from the transcript, preserve negations, and keep output compact."
)

# Case/punctuation-insensitive matching for model-emitted objective keys.
def _vet_normalize_key(raw: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", raw.strip().lower())


_CANONICAL_KEY_LOOKUP: Dict[str, str] = {
    _vet_normalize_key(name): name for name in VET_OBJECTIVE_PARAMS
}
_CANONICAL_KEY_LOOKUP.update({
    "temp": "Temperature",
    "tempc": "Temperature",
    "hr": "Heart Rate",
    "pulse": "Heart Rate",
    "bw": "Weight",
    "bodyweight": "Weight",
    "rr": "Respiratory Rate",
    "resprate": "Respiratory Rate",
    "crt": "Capillary Refill Time",
    "capillaryrefill": "Capillary Refill Time",
    "mucous": "Mucous Membranes",
    "mm": "Mucous Membranes",
    "hydration": "Hydration Status",
    "bcs": "Body Condition Score",
    "bodycondition": "Body Condition Score",
    "pain": "Pain Score",
    "fas": "Fear Anxiety Stress Score",
    "fearanxietystress": "Fear Anxiety Stress Score",
    "fascore": "Fear Anxiety Stress Score",
    "eye": "Eyes",
    "ocular": "Eyes",
    "ear": "Ears",
    "earcanal": "Ears",
    "otoscopy": "Ears",
    "otoscopic": "Ears",
    "nose": "Nasal",
    "nasalcavity": "Nasal",
    "oral": "Oral/Dental",
    "dental": "Oral/Dental",
    "mouth": "Oral/Dental",
    "heart": "Cardiovascular",
    "cv": "Cardiovascular",
    "lung": "Respiratory",
    "lungs": "Respiratory",
    "chest": "Respiratory",
    "auscultation": "Cardiovascular",
    "neuro": "Neurological",
    "msk": "Musculoskeletal",
    "lymphnode": "Lymphatic",
    "lymphnodes": "Lymphatic",
    "gi": "Gastrointestinal",
    "abdomen": "Gastrointestinal",
    "abdominal": "Gastrointestinal",
    "reproductive": "Reproductive/Urinary",
    "urinary": "Reproductive/Urinary",
    "urogenital": "Reproductive/Urinary",
    "skin": "Integument",
    "coat": "Integument",
    "mass": "Masses",
    "lesion": "Masses",
    "lesions": "Masses",
})

_VET_HEADER_NAMES = {
    "subjective": "subjective",
    "objectivementioned": "objective",
    "objective": "objective",
    "assessment": "assessment",
    "plan": "plan",
}


def _vet_split_sections(raw: str) -> Dict[str, str]:
    """Split model output into {subjective, objective, assessment, plan}.

    Deterministic: matches the four mandated headings case-insensitively,
    tolerating a missing colon and in-line content on the heading line. If a
    continuation line without a colon appears inside OBJECTIVE... it is kept
    for the key/value parser. When NO heading is matched at all, the whole
    raw text is retained as the subjective fallback (nothing is discarded).
    """
    buckets: Dict[str, list] = {"subjective": [], "objective": [], "assessment": [], "plan": []}
    current: Optional[str] = None
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        head, sep, rest = stripped.partition(":")
        bucket = _VET_HEADER_NAMES.get(_vet_normalize_key(head))
        # A header colon (or a bare heading word) switches sections; a value
        # line such as "Temperature: 102.5" normalizes to "temperature" which
        # is NOT in the header set, so it cannot be confused with a heading.
        if bucket and (sep == ":" or not rest.strip(" *#\t")):
            current = bucket
            cleaned_rest = rest.strip(" *#\t")
            if cleaned_rest:
                buckets[current].append(cleaned_rest)
            continue
        if current is not None:
            buckets[current].append(stripped)
        # Pre-heading preamble is dropped (title noise like "SOAP Note:").
    found = any(buckets.values())
    if not found:
        buckets["subjective"] = [raw.strip()]
    return {key: "\n".join(lines).strip() for key, lines in buckets.items()}


def _vet_parse_objective(lines_text: str) -> Tuple[Dict[str, str], int]:
    """Parse OBJECTIVE(_MENTIONED) lines into canonical-keyed values.

    Returns (values, unknown_count). `key: value` splits on the first colon
    (falling back to ' - '), canonical names/aliases are matched
    case/punctuation-insensitively, and colon-less continuation lines are
    appended to the PREVIOUS key's value (multi-line exam findings survive).
    Unknown keys are counted, never silently accepted into the shape.
    """
    values: Dict[str, str] = {}
    unknown = 0
    current: Optional[str] = None
    for line in lines_text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        head, sep, value = stripped.partition(":")
        if sep != ":":
            head, sep, value = stripped.partition(" - ")
        canonical = _CANONICAL_KEY_LOOKUP.get(_vet_normalize_key(head)) if sep else None
        if canonical:
            val = value.strip()
            while val.startswith("-"):
                val = val[1:].lstrip()
            values[canonical] = val
            current = canonical
        elif current:
            # Continuation of the previous finding (no key on this line).
            values[current] = f"{values[current]} {stripped}".strip()
        else:
            unknown += 1
    return values, unknown


def _vet_normalize_bullets(text: str) -> str:
    """Every non-empty line becomes a '- ' bullet (deterministic shape)."""
    bullets = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        bullets.append(stripped if stripped.startswith("-") else f"- {stripped}")
    return "\n".join(bullets)


_SKIP_VERB_RE = (
    r"(?:skip(?:ped)?|omit(?:ted)?|defer(?:red)?|unable\s+to\s+(?:check|get|take|obtain)|"
    r"did(?:n't|\s+not)\s+(?:take|check|get|measure|obtain|perform)|"
    r"no\s+(?:rectal\s+)?(?:temp|weight|exam))"
)
_VITAL_SKIP_PATTERNS: Dict[str, Tuple[str, ...]] = {
    "Temperature": ("temperature", "temp", "rectal temp"),
    "Weight": ("weight", "weigh"),
    "Heart Rate": ("heart rate", "pulse", "hr"),
    "Respiratory Rate": ("respiratory rate", "resp rate", "rr"),
    "Capillary Refill Time": ("capillary refill", "crt"),
    "Oral/Dental": ("oral", "dental", "mouth", "teeth"),
    "Ears": ("ears", "ear exam", "otoscopy"),
    "Eyes": ("eyes", "ocular", "ophthalmic"),
}


def _vet_is_skipped_vital(param: str, transcript: Optional[str]) -> bool:
    """Return True when the transcript explicitly states a vital/exam was skipped."""
    if not transcript:
        return False
    aliases = _VITAL_SKIP_PATTERNS.get(param)
    if not aliases:
        aliases = (param.lower(),)
    lower = transcript.lower()
    for alias in aliases:
        esc = re.escape(alias)
        if re.search(rf"\b{_SKIP_VERB_RE}\b[^.\n]{{0,24}}\b{esc}\b", lower):
            return True
        if re.search(rf"\b{esc}\b[^.\n]{{0,24}}\b(?:was\s+)?(?:skipped|omitted|deferred|not\s+(?:taken|performed|done|checked|measured))\b", lower):
            return True
    return False


def _vet_try_parse_json(raw_text: str) -> Optional[Dict[str, Any]]:
    """Parse sparse JSON output cleanly (tolerating ```json fences and mid-token truncation)."""
    stripped = (raw_text or "").strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```(?:json)?\s*", "", stripped, flags=re.IGNORECASE)
        stripped = re.sub(r"\s*```$", "", stripped)
        stripped = stripped.strip()
    start_idx = stripped.find("{")
    if start_idx < 0:
        return None
    stripped = stripped[start_idx:]
    try:
        parsed = json.loads(stripped)
        return parsed if isinstance(parsed, dict) else None
    except ValueError:
        pass

    # Deterministic truncation recovery: trim incomplete trailing field back to clean commas/closes
    # outside of JSON string literals, then close remaining open '[' / '{' in reverse stack order.
    cut_points: List[int] = [len(stripped)]
    in_str = False
    esc = False
    for idx, ch in enumerate(stripped):
        if esc:
            esc = False
            continue
        if ch == "\\" and in_str:
            esc = True
            continue
        if ch == '"':
            in_str = not in_str
        elif not in_str and ch in (",", "}", "]"):
            cut_points.append(idx if ch == "," else idx + 1)

    for end in reversed(cut_points):
        sub = stripped[:end].rstrip().rstrip(",")
        if not sub:
            continue
        stack: List[str] = []
        s_in = False
        s_esc = False
        for ch in sub:
            if s_esc:
                s_esc = False
                continue
            if ch == "\\" and s_in:
                s_esc = True
                continue
            if ch == '"':
                s_in = not s_in
            elif not s_in:
                if ch == "{":
                    stack.append("}")
                elif ch == "[":
                    stack.append("]")
                elif ch in ("}", "]") and stack and stack[-1] == ch:
                    stack.pop()
        if s_in:
            continue
        repaired = sub + "".join(reversed(stack))
        try:
            parsed = json.loads(repaired)
            if isinstance(parsed, dict):
                return parsed
        except ValueError:
            continue
    return None


def _vet_format_subjective(subj: Any) -> str:
    if isinstance(subj, str):
        return subj.strip()
    if not isinstance(subj, dict):
        return ""
    parts: List[str] = []
    summary = str(subj.get("clinical_summary") or subj.get("summary") or "").strip()
    if summary:
        parts.append(summary)
    extras: List[str] = []
    for key, label in (
        ("duration", "Duration"),
        ("appetite", "Appetite"),
        ("water_intake", "Water intake"),
        ("vomiting_diarrhea", "GI (vomiting/diarrhea)"),
        ("known_allergies", "Known allergies"),
    ):
        val = subj.get(key)
        if isinstance(val, str) and val.strip() and val.strip().lower() not in ("null", "none", "n/a"):
            clean_val = val.strip()
            if clean_val.lower() not in summary.lower():
                extras.append(f"{label}: {clean_val}")
    if extras:
        parts.append("; ".join(extras) + ".")
    return " ".join(parts).strip()


def _vet_hydrate_from_parsed_json(
    data: Dict[str, Any], transcript: Optional[str] = None
) -> Tuple[str, Dict[str, str], int, int, Dict[str, Any]]:
    """Hydrate sparse JSON LLM output into the exact 23-param contract + drug annotations."""
    subjective_text = _vet_format_subjective(data.get("subjective"))

    # Objective: sparse dict -> canonical mapping + skipped-vital guard + trace gate
    raw_obj = data.get("objective")
    objective_values: Dict[str, str] = {}
    unknown = 0
    if isinstance(raw_obj, dict):
        for raw_key, raw_val in raw_obj.items():
            if raw_val is None:
                continue
            val_str = str(raw_val).strip() if not isinstance(raw_val, list) else ", ".join(str(x) for x in raw_val if x)
            if not val_str:
                continue
            canonical = _CANONICAL_KEY_LOOKUP.get(_vet_normalize_key(str(raw_key)))
            if canonical:
                objective_values[canonical] = val_str
            else:
                unknown += 1

    transcript_norm = _vet_norm_trace(transcript) if transcript else ""
    if transcript_norm:
        spoken_numbers = _vet_spoken_number_tokens(transcript)
        if spoken_numbers:
            transcript_norm = f"{transcript_norm} {' '.join(spoken_numbers)}".strip()

    objective_map: Dict[str, str] = {}
    drops = 0
    for name in VET_OBJECTIVE_PARAMS:
        if _vet_is_skipped_vital(name, transcript):
            objective_map[name] = VET_NOT_MENTIONED
            continue
        value = _vet_value_or_not_mentioned(objective_values.get(name) or "")
        if transcript and value != VET_NOT_MENTIONED and not _vet_value_traced(value, transcript_norm):
            value = VET_NOT_MENTIONED
            drops += 1
        objective_map[name] = value

    # Assessment bullets
    raw_assess = data.get("assessment")
    assess_lines: List[str] = []
    if isinstance(raw_assess, list):
        assess_lines = [str(item).strip() for item in raw_assess if str(item or "").strip()]
    elif isinstance(raw_assess, str) and raw_assess.strip():
        assess_lines = [line.strip() for line in raw_assess.splitlines() if line.strip()]
    assessment_text = _vet_normalize_bullets("\n".join(assess_lines)) if assess_lines else "- Review pending clinician assessment."

    # Plan bullets + structured plan + deterministic 2-stage drug matching
    raw_plan = data.get("plan")
    plan_lines: List[str] = []
    drug_matches: List[Dict[str, Any]] = []
    plan_structured: Dict[str, Any] = {
        "medications": [],
        "vaccines_administered": [],
        "diagnostics": [],
        "procedures": [],
        "home_care": [],
        "follow_up": None,
    }
    def _append_med_dict(med: Dict[str, Any]) -> None:
        spoken = str(med.get("spoken_name") or med.get("medicine_name") or med.get("name") or "").strip()
        if not spoken:
            return
        match_info = resolve_drug_name(spoken)
        drug_matches.append(match_info)
        plan_structured["medications"].append({**med, "match": match_info})
        parts = [
            str(med.get(k)).strip()
            for k in ("dose", "route", "frequency")
            if med.get(k) and str(med.get(k)).strip().lower() not in ("null", "none")
        ]
        dur = str(med.get("duration") or "").strip()
        if dur and dur.lower() not in ("null", "none"):
            parts.append(f"for {dur}")
        instr = str(med.get("instructions") or "").strip()
        if instr and instr.lower() not in ("null", "none"):
            parts.append(f"({instr})")
        detail = ", ".join(parts) if parts else "details not fully specified"
        if match_info["status"] == "UNKNOWN":
            plan_lines.append(f'[UNVERIFIED DRUG: "{spoken}"]: {detail}')
        elif match_info["status"] == "NEEDS_REVIEW":
            plan_lines.append(f"{spoken} [{match_info['prompt_text']}]: {detail}")
        else:
            canonical_note = (
                f" (matched: {match_info['matched_canonical']})"
                if match_info["matched_canonical"]
                and match_info["matched_canonical"].lower() != spoken.lower()
                else ""
            )
            plan_lines.append(f"{spoken}{canonical_note}: {detail}")

    if isinstance(raw_plan, dict):
        vaccines = [str(v).strip() for v in (raw_plan.get("vaccines_administered") or []) if str(v or "").strip()]
        plan_structured["vaccines_administered"] = vaccines
        if vaccines:
            plan_lines.append(f"Administered vaccines today: {', '.join(vaccines)}")

        meds = raw_plan.get("medications") or []
        if isinstance(meds, list):
            for med in meds:
                if isinstance(med, dict):
                    _append_med_dict(med)
                elif isinstance(med, str) and med.strip():
                    plan_lines.append(med.strip())

        for key, prefix in (
            ("diagnostics", "Diagnostic ordered"),
            ("procedures", "Procedure performed"),
            ("home_care", "Home care"),
        ):
            raw_items = raw_plan.get(key) or []
            clean_items: List[str] = []
            for item in raw_items:
                if isinstance(item, dict):
                    _append_med_dict(item)
                elif str(item or "").strip():
                    s_item = str(item).strip()
                    clean_items.append(s_item)
                    plan_lines.append(f"{prefix}: {s_item}")
            plan_structured[key] = clean_items

        fu = raw_plan.get("follow_up")
        if isinstance(fu, str) and fu.strip() and fu.strip().lower() not in ("null", "none"):
            plan_structured["follow_up"] = fu.strip()
            plan_lines.append(f"Follow-up / recheck: {fu.strip()}")
    elif isinstance(raw_plan, list):
        for item in raw_plan:
            if isinstance(item, dict):
                _append_med_dict(item)
            elif str(item or "").strip():
                plan_lines.append(str(item).strip())
    elif isinstance(raw_plan, str) and raw_plan.strip():
        plan_lines = [line.strip() for line in raw_plan.splitlines() if line.strip()]

    plan_text = _vet_normalize_bullets("\n".join(plan_lines)) if plan_lines else "- Recheck and clinician review."

    objective_text = "\n".join(f"{name}: {value}" for name, value in objective_map.items())
    sections: Dict[str, Any] = {
        "subjective": subjective_text,
        "objective_map": objective_map,
        "objective_text": objective_text,
        "assessment": assessment_text,
        "plan": plan_text,
    }
    draft_text = (
        "SUBJECTIVE:\n"
        f"{sections['subjective']}\n\n"
        "OBJECTIVE_MENTIONED:\n"
        f"{objective_text}\n\n"
        "ASSESSMENT:\n"
        f"{sections['assessment']}\n\n"
        "PLAN:\n"
        f"{sections['plan']}"
    )
    meta = {
        "drug_matches": drug_matches,
        "plan_structured": plan_structured,
        "subjective_details": data.get("subjective") if isinstance(data.get("subjective"), dict) else None,
        "json_mode": True,
    }
    return draft_text, sections, unknown, drops, meta


def _vet_hydrated_story(
    raw_text: str, transcript: Optional[str] = None
) -> Tuple[str, Dict[str, Any], int, int]:
    """Build the hydrated (draft_text, sections, unknown, drops) tuple.

    Supports both the new sparse JSON extraction output and the legacy
    SUBJECTIVE/OBJECTIVE_MENTIONED/ASSESSMENT/PLAN text format cleanly.
    """
    parsed_json = _vet_try_parse_json(raw_text)
    if parsed_json is not None:
        draft_text, sections, unknown, drops, _ = _vet_hydrate_from_parsed_json(
            parsed_json, transcript=transcript
        )
        return draft_text, sections, unknown, drops

    buckets = _vet_split_sections(raw_text)
    objective_values, unknown = _vet_parse_objective(buckets["objective"])
    transcript_norm = _vet_norm_trace(transcript) if transcript else ""
    if transcript_norm:
        spoken_numbers = _vet_spoken_number_tokens(transcript)
        if spoken_numbers:
            transcript_norm = f"{transcript_norm} {' '.join(spoken_numbers)}".strip()
    objective_map: Dict[str, str] = {}
    drops = 0
    for name in VET_OBJECTIVE_PARAMS:
        if _vet_is_skipped_vital(name, transcript):
            objective_map[name] = VET_NOT_MENTIONED
            continue
        value = _vet_value_or_not_mentioned(objective_values.get(name) or "")
        if transcript and value != VET_NOT_MENTIONED and not _vet_value_traced(value, transcript_norm):
            value = VET_NOT_MENTIONED
            drops += 1
        objective_map[name] = value
    objective_text = "\n".join(f"{name}: {value}" for name, value in objective_map.items())
    sections: Dict[str, Any] = {
        "subjective": buckets["subjective"],
        "objective_map": objective_map,
        "objective_text": objective_text,
        "assessment": _vet_normalize_bullets(buckets["assessment"]),
        "plan": _vet_normalize_bullets(buckets["plan"]),
    }
    draft_text = (
        "SUBJECTIVE:\n"
        f"{sections['subjective']}\n\n"
        "OBJECTIVE_MENTIONED:\n"
        f"{objective_text}\n\n"
        "ASSESSMENT:\n"
        f"{sections['assessment']}\n\n"
        "PLAN:\n"
        f"{sections['plan']}"
    )
    return draft_text, sections, unknown, drops


# ---- transformers cross-version helpers ------------------------------------
# The 2026-10-30 Colab real-inference gate caught an unpinned-resolve drift:
# `apply_chat_template(..., tokenize=True, return_tensors="pt")` returns a raw
# torch.Tensor on the VERIFIED 4.48.3 stack, but a BatchEncoding mapping on
# newer transformers - whose `.shape` access raised KeyError('shape'). The
# exact runtime is pinned in requirements-serving-ml.txt, and these helpers
# accept BOTH shapes so call-sites survive any future re-pin honestly.

def _unwrap_chat_prompt(prompt: Any) -> Tuple[Any, Optional[Any]]:
    """Return (input_ids, attention_mask|None) from either template return shape."""
    ids = prompt["input_ids"] if hasattr(prompt, "input_ids") else prompt
    return ids, getattr(prompt, "attention_mask", None)


def _prep_dtype_kwargs(torch_dtype: Any) -> Dict[str, Any]:
    """`from_pretrained` renamed torch_dtype -> dtype in newer transformers.
    Choose the kwarg from the INSTALLED version instead of relying on warning
    text - the wrong kwarg either TypeErrors or emits a deprecation warning."""
    try:
        import transformers

        parts = str(transformers.__version__).split(".")
        if (int(parts[0]), int(parts[1])) >= (4, 56):
            return {"dtype": torch_dtype}
    except Exception:
        pass  # version unreadable -> keep the long-standing kwarg name
    return {"torch_dtype": torch_dtype}


class ProviderError(Exception):
    """Controlled, honest provider failure - the API layer maps it to JSON."""

    status_code = 500
    code = "provider_error"

    def __init__(self, message: str, *, detail: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.message = message
        self.detail = detail or {}


class BadRequest(ProviderError):
    status_code = 400
    code = "bad_request"


class NotConfigured(ProviderError):
    status_code = 501
    code = "not_configured"


class UnknownProvider(ProviderError):
    status_code = 400
    code = "unknown_provider"


class InferenceError(ProviderError):
    status_code = 503
    code = "inference_error"


class CompatibilityError(ProviderError):
    status_code = 503
    code = "adapter_compatibility_error"


class DraftBusy(ProviderError):
    """Single-flight guard: one draft at a time (avoids OOM/thrash stacking)."""

    status_code = 409
    code = "draft_busy"


class DraftCancelled(Exception):
    """Operator-cancelled draft. Raised from the decode loop within 1 token so
    the worker thread exits (no zombie CPU burn) - never a ProviderError, the
    async job manager maps it to status="cancelled"."""

    def __init__(self, message: str = "draft cancelled"):
        super().__init__(message)
        self.message = message


def manifest_read(adapter_dir: Optional[Path]) -> Optional[Dict[str, Any]]:
    """Read a training manifest. None when absent, marker-dict when corrupt.

    Never raises: scale labels and /health must stay available even when the
    manifest is missing or unreadable.
    """
    if not adapter_dir:
        return None
    path = Path(adapter_dir) / "training_manifest.json"
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"_corrupt_manifest": True}


def resolve_scale(manifest: Optional[Dict[str, Any]]) -> Tuple[str, str]:
    """(label, source) - explicit, non-fabricating model_scale resolution.

    Precedence:
      1. manifest["model_scale"]  (phase-3 artifacts; tagged at train time)
      2. derived from train_rows  (phase-2 artifacts predating the tag)
      3. UNKNOWN(...)             (nothing to read)
    <=500 train rows was the largest phase-2 smoke cap (ASR 180, SOAP 100);
    phase-3 full-scale begins at 400/1200/2000, so the threshold cleanly
    separates the generations.
    """
    if manifest and not manifest.get("_corrupt_manifest"):
        tag = manifest.get("model_scale")
        if tag:
            return str(tag).upper(), "training_manifest.model_scale"
        rows = manifest.get("train_rows")
        if isinstance(rows, int) and rows >= 0:
            if rows <= 500:
                return "SMOKE(assumed: manifest predates the model_scale tag; small train_rows)", "derived_from_train_rows"
            return "UNTAGGED(assumed: manifest predates the model_scale tag; larger train_rows)", "derived_from_train_rows"
    if manifest and manifest.get("_corrupt_manifest"):
        return "UNKNOWN(corrupt training_manifest.json)", "unreadable"
    return "UNKNOWN(no training_manifest.json in the adapter dir)", "missing_manifest"


class MLProvider:
    """Lazy-loading local provider for the VoxSOAP ML components.

    Nothing imports or loads anything heavy until a request asks for a
    component. unload() drops references and (when torch is present and CUDA
    is in use) empties the CUDA cache - the Windows RAM safeguard.
    """

    name = "ml"
    is_mock = False

    def __init__(self, cfg: Any):
        self._cfg = cfg
        self.components: Dict[str, Dict[str, Any]] = {
            "asr": {
                "adapter_dir": cfg.asr_adapter_dir,
                "base_model": cfg.asr_base_model,
                "base_revision": cfg.asr_base_revision,
            },
            "soap": {
                "adapter_dir": cfg.soap_adapter_dir,
                "base_model": cfg.soap_base_model,
                "base_revision": cfg.soap_base_revision,
            },
            "roman": {
                "adapter_dir": getattr(cfg, "roman_adapter_dir", None),
                "base_model": getattr(cfg, "roman_base_model", "google/mt5-small"),
                "base_revision": getattr(cfg, "roman_base_revision", "main"),
            },
        }
        self._loaded: Dict[str, Optional[Dict[str, Any]]] = {k: None for k in COMPONENT_KEYS}
        self._scale_cache: Dict[str, Tuple[str, str]] = {}

    # ---------- introspection (no heavy imports; safe for /health) ----------

    def scale_for(self, key: str) -> Tuple[str, str]:
        if key not in self.components:
            raise UnknownProvider(f"unknown component {key!r}")
        cached = self._scale_cache.get(key)
        if cached is not None:
            return cached
        resolved = resolve_scale(manifest_read(self.components[key]["adapter_dir"]))
        self._scale_cache[key] = resolved
        return resolved

    def describe(self) -> Dict[str, Dict[str, Any]]:
        out: Dict[str, Dict[str, Any]] = {}
        for key in COMPONENT_KEYS:
            try:
                comp = self.components[key]
                adapter_dir = comp["adapter_dir"]
                files_ok = False
                if adapter_dir and (Path(adapter_dir) / "adapter_config.json").is_file() \
                        and (Path(adapter_dir) / "adapter_model.safetensors").is_file():
                    files_ok = True
                scale_label, scale_source = resolve_scale(manifest_read(adapter_dir))
                state = self._loaded.get(key)
                out[key] = {
                    "adapter_dir": str(adapter_dir) if adapter_dir else None,
                    "configured": adapter_dir is not None,
                    "adapter_files_present": files_ok,
                    "base_model": comp["base_model"],
                    "base_revision": comp["base_revision"],
                    "model_scale": scale_label,
                    "model_scale_source": scale_source,
                    "loaded": state is not None,
                }
                if key == "soap" and state is not None:
                    out[key]["backend"] = state.get("backend", "torch")
            except Exception as err:  # never break /health over introspection
                out[key] = {"error": f"{type(err).__name__}: {err}"}
        return out

    # ---------- validation ----------

    def _require_adapter(self, key: str) -> Dict[str, Any]:
        comp = self.components[key]
        adapter_dir = comp["adapter_dir"]
        if adapter_dir is None:
            if key == "roman":
                raise NotConfigured(
                    "/roman is intentionally a 501 by design: Model C (mT5 Roman Urdu transliteration) was DEPRECATED on "
                    "2026-10-29 after three training recipes failed their evaluations (runs 9/10/11: sentinel collapse, "
                    "then loss plateau, then repetition loops; CER 6.8905, exact_match 0.0). VOXSOAP_ROMAN_ADAPTER_DIR "
                    "remains a diagnostics-only override requiring a training_manifest.json + adapter_model.safetensors "
                    "from a supervised owner-approved re-enable attempt. Nothing was silently substituted (no Gemini fallback).",
                )
            raise NotConfigured(
                f"{key.upper()} adapter directory is not configured; set the VOXSOAP_{key.upper()}_ADAPTER_DIR env var."
            )
        d = Path(adapter_dir)
        missing = [f for f in ("adapter_config.json", "adapter_model.safetensors") if not (d / f).is_file()]
        if missing:
            raise NotConfigured(
                f"{key.upper()} adapter directory {d} is missing {', '.join(missing)} - an adapter without its "
                "files is NOT usable and nothing was fabricated or substituted."
            )
        manifest = manifest_read(d)
        if manifest and not manifest.get("_corrupt_manifest"):
            manifest_base = manifest.get("base_model_id")
            if manifest_base and manifest_base != comp["base_model"]:
                raise CompatibilityError(
                    f"{key.upper()} adapter manifest declares base_model_id={manifest_base!r} but serving is "
                    f"configured for base model {comp['base_model']!r}. An adapter is NOT a complete model and "
                    "MUST be paired with the exact base checkpoint it was trained on. Fix VOXSOAP_"
                    f"{key.upper()}_BASE_MODEL or point VOXSOAP_{key.upper()}_ADAPTER_DIR at a matching adapter."
                )
            manifest_rev = manifest.get("base_model_revision")
            if manifest_rev and manifest_rev != comp["base_revision"]:
                raise CompatibilityError(
                    f"{key.upper()} adapter manifest declares base_model_revision={manifest_rev!r} but serving "
                    f"is configured for revision {comp['base_revision']!r} - refusing to load a mismatched base."
                )
        elif manifest and manifest.get("_corrupt_manifest"):
            raise CompatibilityError(
                f"{key.upper()} adapter training_manifest.json in {d} is unreadable - refusing to load without "
                "verifiable base-model compatibility."
            )
        return comp

    # ---------- real-inference stack ----------

    @staticmethod
    def _real_stack():
        """Import torch/numpy/transformers/peft or raise an honest 503.

        Deliberately NOT auto-installing anything, and NOT falling back to the
        Gemini provider (never happens by design).
        """
        try:
            import numpy  # noqa: F401
            import peft  # noqa: F401
            import torch  # noqa: F401
            import transformers  # noqa: F401
            return torch
        except Exception as err:  # ImportError or broken dependency
            raise InferenceError(
                f"Real ML inference is unavailable in this Python environment: {type(err).__name__}: {err}. "
                "This machine currently runs 32-bit Python 3.15, which has no torch win32 wheels: install a "
                "64-bit interpreter with torch 2.x (CUDA build), transformers, peft, numpy, accelerate - or run "
                "the serving check on Colab. The request was NOT silently routed to Gemini."
            ) from err

    def _resolve_device(self):
        if self._cfg.device != "auto":
            return self._cfg.device
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"

    # ---------- component loaders ----------

    def _load_asr(self) -> Dict[str, Any]:
        comp = self._require_adapter("asr")
        torch = self._real_stack()
        from peft import PeftModel
        from transformers import WhisperForConditionalGeneration, WhisperProcessor

        device = self._resolve_device()
        dtype = torch.float16 if device == "cuda" else torch.float32
        processor = WhisperProcessor.from_pretrained(str(comp["adapter_dir"]))
        base = WhisperForConditionalGeneration.from_pretrained(
            comp["base_model"], revision=comp["base_revision"], **_prep_dtype_kwargs(dtype)
        )
        # The Whisper checkpoint ships a STALE generation_config default
        # (forced_decoder_ids = [[1, None], [2, 50359]]). transformers 4.48
        # IGNORES it whenever task/language kwargs are passed (the live server
        # log proved exactly that conflict warning) - our generate recipe
        # (evaluate_asr.py: max_new_tokens + language + task) is kwarg-driven.
        # Clearing the stale default here is therefore a NO-OP for behaviour;
        # it only removes the false-conflict warning noise at generate time.
        stale_forced_ids = getattr(base, "generation_config", None)
        if stale_forced_ids is not None and getattr(stale_forced_ids, "forced_decoder_ids", None):
            stale_forced_ids.forced_decoder_ids = None
        model = PeftModel.from_pretrained(base, str(comp["adapter_dir"]))
        model.to(device)
        model.eval()
        if device == "cpu":
            # Owner Fix 1 (2026-11-01): saturate every physical core - the
            # default intra-op pool leaves half the machine idle on Whisper
            # decode. torch.set_num_threads is PROCESS-GLOBAL and sticky: the
            # draft path deliberately re-bounds it lower (loop headroom, see
            # draft()), so transcribe() re-applies this Fix-1 saturation
            # defensively on every call (the comment previously promised that
            # re-apply and it was missing).
            threads = _boot_os.cpu_count() or 1
            torch.set_num_threads(threads)
            if _boot_os.environ.get("VOXSOAP_ASR_QUANT", "").strip() == "1":
                # Optional fast path, DEFAULT OFF: dynamic qint8 quantization
                # rewrites EVERY Linear in place - including the PEFT
                # lora_A/lora_B projections - which is an unverified
                # eval-parity + adapter-interaction risk. Explicit opt-in
                # knob (VOXSOAP_ASR_QUANT=1), never a silent default; torch
                # set_num_threads already delivers a large CPU win.
                from torch.ao.quantization import quantize_dynamic

                model = quantize_dynamic(model, {torch.nn.Linear}, dtype=torch.qint8)
        state = {"model": model, "processor": processor, "device": device, "loaded_at": time.time()}
        self._loaded["asr"] = state
        return state

    def _load_soap(self) -> Dict[str, Any]:
        comp = self._require_adapter("soap")
        torch = self._real_stack()
        from peft import PeftModel
        from transformers import AutoModelForCausalLM, AutoTokenizer

        device = self._resolve_device()
        # 2026-10-31 local-speed fix: the fp32 3B CPU load is ~12.4 GB against
        # a 15.9 GB machine (disk-swap city). PyTorch CPU supports bfloat16
        # natively on x86_64 (oneDNN): bf16 weights are ~6.2 GB AND matmuls
        # run FASTER than fp32 on this stack. fp16 remains the CUDA choice;
        # VOXSOAP_SOAP_DTYPE=bfloat16|float16|float32 is the honest override.
        # (mt5/roman keeps its fp32 master - its direct-fp16 NaN guard note
        # above does not apply here: Qwen is a causal LM, not a T5 family.)
        dtype_env = str(getattr(self._cfg, "soap_dtype", "auto") or "auto").strip().lower()
        if dtype_env in ("bfloat16", "bf16"):
            dtype = torch.bfloat16
        elif dtype_env == "float16":
            dtype = torch.float16
        elif dtype_env == "float32":
            dtype = torch.float32
        else:  # auto
            dtype = torch.float16 if device == "cuda" else torch.bfloat16
        tokenizer_src = str(comp["adapter_dir"])
        try:
            tok = AutoTokenizer.from_pretrained(tokenizer_src)
        except Exception:
            # Same checkpoint family only: the adapter's manifest base id and
            # revision were ALREADY validated against the configured base in
            # _require_adapter(), so falling back to that validated base's
            # tokenizer is safe (never a silent cross-model mix).
            tok = AutoTokenizer.from_pretrained(comp["base_model"], revision=comp["base_revision"])
        load_kwargs = _prep_dtype_kwargs(dtype)
        if device == "cpu":
            # accelerate-backed lazy load: builds the fp/bf16 skeleton then
            # streams weights in, avoiding a transient fp32 copy of the base.
            load_kwargs["low_cpu_mem_usage"] = True
        base = AutoModelForCausalLM.from_pretrained(
            comp["base_model"], revision=comp["base_revision"], **load_kwargs
        )
        model = PeftModel.from_pretrained(base, str(comp["adapter_dir"]))
        model.to(device)
        model.eval()
        state = {"model": model, "tokenizer": tok, "device": device, "loaded_at": time.time()}
        self._loaded["soap"] = state
        return state

    def _load_roman(self) -> Dict[str, Any]:
        comp = self._require_adapter("roman")
        torch = self._real_stack()
        from peft import PeftModel
        from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

        device = self._resolve_device()
        # mt5/T5-family: fp32 masters (direct-fp16 NaN guard documented in the
        # training scripts). CPU-first dtype keeps that guarantee everywhere.
        base = AutoModelForSeq2SeqLM.from_pretrained(
            comp["base_model"], revision=comp["base_revision"]
        )
        model = PeftModel.from_pretrained(base, str(comp["adapter_dir"]))
        model.to(device)
        model.eval()
        tok = AutoTokenizer.from_pretrained(str(comp["adapter_dir"]))
        state = {"model": model, "tokenizer": tok, "device": device, "loaded_at": time.time()}
        self._loaded["roman"] = state
        return state

    # ---------- fast CPU GGUF draft backend (owner fix 2026-11-19) ----------

    @staticmethod
    def _gguf_available() -> bool:
        """True when llama-cpp-python imports cleanly in this venv."""
        try:
            import llama_cpp  # noqa: F401

            return True
        except Exception:
            return False

    def _soap_backend_for(self, fmt: str, device: str) -> str:
        """Resolve the draft backend honestly (never a silent swap).

        Rules:
          * VOXSOAP_SOAP_BACKEND=torch -> torch (explicit operator choice);
          * "medscribe" (legacy SOAP-LoRA adapter contract) -> torch ALWAYS;
          * CUDA -> torch (this GGUF path is a CPU backend, n_gpu_layers=0);
          * explicit "gguf" -> gguf, refusing with an honest 503 when
            llama-cpp-python is missing;
          * "auto" -> gguf on CPU when llama_cpp imports, else torch.
        """
        configured = str(getattr(self._cfg, "soap_backend", "auto") or "auto").strip().lower()
        if configured == "torch":
            return "torch"
        if fmt != VET_NOTE_FORMAT:
            return "torch"
        if device != "cpu":
            return "torch"
        if configured == "gguf":
            if not self._gguf_available():
                raise InferenceError(
                    "VOXSOAP_SOAP_BACKEND=gguf but llama-cpp-python is not installed in this "
                    "Python environment. Install the pinned CPU wheel (ml-serving/"
                    "requirements-serving-ml.txt) or set VOXSOAP_SOAP_BACKEND=torch. Nothing "
                    "was silently substituted."
                )
            return "gguf"
        return "gguf" if self._gguf_available() else "torch"

    def soap_backend_summary(self) -> Dict[str, Any]:
        """Honest backend provenance for /health and async job envelopes."""
        configured = str(getattr(self._cfg, "soap_backend", "auto") or "auto").strip().lower()
        state = self._loaded.get("soap")
        if state is not None:
            effective = str(state.get("backend", "torch"))
        elif configured == "torch":
            effective = "torch"
        elif configured == "gguf":
            effective = "gguf"
        else:
            effective = "gguf" if self._gguf_available() else "torch"
        summary: Dict[str, Any] = {
            "configured": configured,
            "effective": effective,
            "loaded": state is not None,
            "gguf_repo": getattr(self._cfg, "soap_gguf_repo", None),
            "gguf_file": getattr(self._cfg, "soap_gguf_file", None),
        }
        if state is not None and state.get("backend") == "gguf":
            summary["gguf_file"] = state.get("model_file")
            summary["n_ctx"] = state.get("n_ctx")
            summary["n_threads"] = state.get("n_threads")
            summary["n_batch"] = state.get("n_batch")
            summary["n_ubatch"] = state.get("n_ubatch")
        return summary

    def _resolve_gguf_model_path(self) -> Path:
        explicit = getattr(self._cfg, "soap_gguf_path", None)
        if explicit:
            path = Path(explicit)
            if not path.is_file():
                raise InferenceError(
                    f"VOXSOAP_SOAP_GGUF_PATH points at {path} but the file does not exist - "
                    "download the GGUF first or unset the override. Nothing was substituted."
                )
            return path
        repo = str(getattr(self._cfg, "soap_gguf_repo", "Qwen/Qwen2.5-3B-Instruct-GGUF"))
        filename = str(
            getattr(self._cfg, "soap_gguf_file", "qwen2.5-3b-instruct-q4_k_m.gguf")
        )
        # Local ml-serving/models/<filename> auto-discovery (owner fix 2026-11-20):
        # pre-fetched verified GGUF blobs live here so local launches never stall
        # re-downloading from a throttled HuggingFace CDN.
        local_candidate = Path(__file__).resolve().parent / "models" / filename
        if local_candidate.is_file():
            return local_candidate
        try:
            from huggingface_hub import hf_hub_download

            cached = hf_hub_download(repo_id=repo, filename=filename)
        except Exception as err:
            raise InferenceError(
                "The GGUF SOAP model could not be resolved from the HuggingFace cache "
                f"({repo}/{filename}): {type(err).__name__}: {err}. Pre-download it with "
                "huggingface_hub.hf_hub_download(...) or set VOXSOAP_SOAP_GGUF_PATH to a local "
                ".gguf file. Nothing was silently substituted."
            ) from err
        return Path(cached)

    def _load_soap_gguf(self) -> Dict[str, Any]:
        device = self._resolve_device()
        if device != "cpu":
            raise InferenceError(
                "the GGUF draft backend is the CPU fast path (n_gpu_layers=0); this process "
                f"resolved device={device!r}. Use VOXSOAP_SOAP_BACKEND=torch on CUDA."
            )
        path = self._resolve_gguf_model_path()
        try:
            from llama_cpp import Llama
        except Exception as err:
            raise InferenceError(
                f"llama-cpp-python is not importable: {type(err).__name__}: {err}. Install the "
                "pinned CPU wheel from ml-serving/requirements-serving-ml.txt. Nothing was "
                "silently substituted."
            ) from err
        n_ctx = max(512, int(getattr(self._cfg, "soap_n_ctx", 4096) or 4096))
        cfg_threads = int(getattr(self._cfg, "soap_n_threads", 0) or 0)
        n_threads = cfg_threads if cfg_threads > 0 else max(2, (_boot_os.cpu_count() or 4) - 1)
        n_batch = max(1, int(getattr(self._cfg, "soap_n_batch", 128) or 128))
        n_ubatch = max(1, int(getattr(self._cfg, "soap_n_ubatch", 128) or 128))
        n_ubatch = min(n_ubatch, n_batch)
        try:
            llm = Llama(
                model_path=str(path),
                n_ctx=n_ctx,
                n_threads=n_threads,
                n_batch=n_batch,
                n_ubatch=n_ubatch,
                n_gpu_layers=0,
                verbose=False,
            )
        except Exception as err:
            raise InferenceError(
                f"GGUF SOAP model load failed for {path}: {type(err).__name__}: {err}. "
                "Nothing was silently substituted (no Gemini fallback)."
            ) from err
        state = {
            "backend": "gguf",
            "llm": llm,
            "model_path": str(path),
            "model_file": path.name,
            "n_ctx": n_ctx,
            "n_threads": n_threads,
            "n_batch": n_batch,
            "n_ubatch": n_ubatch,
            "loaded_at": time.time(),
        }
        self._loaded["soap"] = state
        return state

    def _draft_gguf(
        self,
        state: Dict[str, Any],
        transcript: str,
        tokens_cap: int,
        cancel_event: Optional[Any] = None,
        progress_cb: Optional[Any] = None,
    ) -> str:
        """Stream a greedy chat completion from the resident GGUF model.

        The SAME VET_SCRIBENOTE_SYSTEM_PROMPT + raw transcript are fed; the
        caller pipes the text through the SAME deterministic hydration/guard
        pipeline as the torch path. Cancellation is checked on EVERY chunk
        (one token) and raises DraftCancelled so the worker exits immediately.
        """
        llm = state["llm"]
        messages = [
            {"role": "system", "content": VET_SCRIBENOTE_SYSTEM_PROMPT},
            {"role": "user", "content": transcript},
        ]
        if cancel_event is not None and cancel_event.is_set():
            raise DraftCancelled("draft cancelled before generation")
        call_kwargs: Dict[str, Any] = {
            "messages": messages,
            "temperature": 0.0,
            "repeat_penalty": 1.1,
            "max_tokens": int(tokens_cap),
            "stream": True,
            "response_format": {"type": "json_object"},
        }
        try:
            stream = llm.create_chat_completion(**call_kwargs)
        except TypeError:
            call_kwargs.pop("response_format", None)
            stream = llm.create_chat_completion(**call_kwargs)
        parts = []
        generated = 0
        try:
            for chunk in stream:
                if cancel_event is not None and cancel_event.is_set():
                    raise DraftCancelled("draft cancelled by the operator")
                try:
                    choice = (chunk.get("choices") or [{}])[0]
                    delta = (choice.get("delta") or {}).get("content") or ""
                except Exception:
                    delta = ""
                if delta:
                    parts.append(delta)
                    generated += 1
                    if progress_cb is not None:
                        try:
                            progress_cb(generated)
                        except Exception:
                            pass  # observability must never break inference
        finally:
            close = getattr(stream, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass
        return "".join(parts).strip()

    @staticmethod
    def _torch_stopping_criteria(cancel_event, progress_cb, prompt_len):
        """Cancel + live token progress for the torch generate() loop."""
        from transformers import StoppingCriteria, StoppingCriteriaList

        class _DraftStopping(StoppingCriteria):
            def __call__(self, input_ids, scores, **kwargs):  # noqa: D401
                try:
                    generated = int(input_ids.shape[-1]) - int(prompt_len)
                except Exception:
                    generated = 0
                if progress_cb is not None:
                    try:
                        progress_cb(max(0, generated))
                    except Exception:
                        pass
                return bool(cancel_event is not None and cancel_event.is_set())

        return StoppingCriteriaList([_DraftStopping()])

    @staticmethod
    def _finalize_vet_draft(
        raw_text: str, transcript: str, tokens_cap: int
    ) -> Dict[str, Any]:
        """Shared deterministic post-processing for BOTH draft backends."""
        parsed_json = _vet_try_parse_json(raw_text)
        extra_meta: Dict[str, Any] = {}
        if parsed_json is not None:
            draft_text, sections, unknown_dropped, trace_dropped, extra_meta = (
                _vet_hydrate_from_parsed_json(parsed_json, transcript=transcript)
            )
        else:
            draft_text, sections, unknown_dropped, trace_dropped = _vet_hydrated_story(
                raw_text, transcript=transcript
            )
        note = (
            "assistive DRAFT - deterministic guard annotations attached; "
            "vet confirmation is mandatory"
        )
        if unknown_dropped:
            note += (
                f" ({unknown_dropped} unrecognized objective line(s) dropped by "
                "canonical-key matching)"
            )
        if trace_dropped:
            note += (
                f" ({trace_dropped} objective value(s) dropped: no verbatim trace "
                "in the consultation transcript - untraceable claims are never "
                "invented into the note)"
            )
        out: Dict[str, Any] = {
            "draft": draft_text,
            "sections": sections,
            "format": VET_NOTE_FORMAT,
            "generation": "greedy",
            "max_new_tokens": tokens_cap,
            "note": note,
        }
        if extra_meta.get("drug_matches"):
            out["drug_matches"] = extra_meta["drug_matches"]
        if extra_meta.get("plan_structured"):
            out["plan_structured"] = extra_meta["plan_structured"]
        if extra_meta.get("subjective_details"):
            out["subjective_details"] = extra_meta["subjective_details"]
        return out

    # ---------- inference ----------

    def _free_ram_gb(self) -> Optional[float]:
        """Best-effort free-physical-RAM probe with NO new dependency (the
        pinned stack stays untouched): Win32 GlobalMemoryStatusEx via ctypes,
        /proc/meminfo MemAvailable on POSIX. Returns None when unanswerable -
        introspection must NEVER break inference."""
        try:
            if _boot_os.name == "nt":
                import ctypes

                class _MemoryStatusEx(ctypes.Structure):
                    _fields_ = [
                        ("dwLength", ctypes.c_ulong),
                        ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong),
                        ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong),
                        ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong),
                        ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                    ]

                stat = _MemoryStatusEx()
                stat.dwLength = ctypes.sizeof(_MemoryStatusEx)
                if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
                    return stat.ullAvailPhys / (1024.0 ** 3)
                return None
            with open("/proc/meminfo", "r", encoding="utf-8") as fh:
                for line_ in fh:
                    if line_.startswith("MemAvailable:"):
                        return float(line_.split()[1]) / (1024.0 * 1024.0)
        except Exception:
            return None
        return None

    def _release_asr_before_draft(self) -> None:
        """Owner budget fix (2026-11-05): on CPU the fp32 Whisper (~1.2 GB) is
        released BEFORE the SOAP model load/generation on EVERY draft. The
        2026-11-04/05 drills proved the alternative: with Whisper resident the
        16 GB owner box (Chrome + Next dev + IDE) drops to 1.1-2.5 GB free and
        the same draft stretches from ~470 s to ~1,100 s under disk paging; on
        a COLD load the Whisper+Qwen peak is what tips it over. The next
        /transcribe reloads Whisper on demand (one cold Whisper load per
        transcribe-after-draft turn). Opt-out: VOXSOAP_ASR_RELEASE_BEFORE_DRAFT
        =0 (Whisper stays resident; owner unloads via POST /unload {asr})."""
        if not self._loaded.get("asr"):
            return
        if not _ASR_RELEASE_BEFORE_DRAFT:
            return
        free_gb = self._free_ram_gb()
        try:
            self.unload("asr")
            free_after = self._free_ram_gb()
            before_label = "?" if free_gb is None else f"{free_gb:.1f} GB"
            after_label = (
                "?" if free_after is None else f"{free_after:.1f} GB"
            )
            print(
                "[voxsoap-ml] ASR released before draft generation "
                f"(free RAM {before_label} -> {after_label}; the next "
                "/transcribe reloads Whisper on demand).",
                flush=True,
            )
        except Exception as cleanup_err:  # never let the sweep break the draft
            print(
                f"[voxsoap-ml] ASR pre-draft release skipped "
                f"({type(cleanup_err).__name__}: {cleanup_err}).",
                flush=True,
            )

    def transcribe(self, samples, sample_rate: int, audio_bytes: Optional[bytes] = None,
                   language: str = "ur") -> Dict[str, Any]:
        try:
            state = self._loaded["asr"] or self._load_asr()
            torch = self._real_stack()
            import numpy as np

            model = state["model"]
            processor = state["processor"]
            # Owner Fix 1 contract (the comment promised this per-call
            # re-apply and it was missing): torch.set_num_threads is
            # process-global and STICKY - after draft() bounded it to keep
            # loop headroom, every transcribe re-applies the Fix-1 saturation
            # (never shrinks: an explicit VOXSOAP_DRAFT_THREADS setting stays
            # a draft-only cap; Fix-1 saturation treats WHISPER decode only).
            if state.get("device") == "cpu":
                saturate = _boot_os.cpu_count() or 1
                if torch.get_num_threads() < saturate:
                    torch.set_num_threads(saturate)
            speech = np.asarray(samples, dtype=np.float32)

            # Language contract for /transcribe: explicit "ur"/"en" tag the
            # decoder with the SAME recipe the verified eval pipeline used
            # (language + task kwargs); "auto" omits the language kwarg so
            # Whisper detects language from the audio. Values are validated in
            # the API layer; the default stays "ur" (the original scaffold
            # behaviour - no silent contract change for existing callers).
            lang_key = (language or "ur").strip().lower()
            lang_whisper = {"ur": "urdu", "en": "english"}.get(lang_key)
            # Owner Fix 1 (2026-11-01, FLEURS early-cutoff): the ur-LoRA
            # adapter was trained on FLEURS clips - single 5-8 s sentences
            # padded to 30 s - so on DENSE continuous English dialogue it
            # prematurely emits </s> after 1-2 sentences. English therefore
            # decodes with the UNCORRUPTED base openai/whisper-small weights
            # (adapter disabled); Urdu keeps the adapter; "auto" also keeps
            # it (documented: explicit 'en' is the English escape hatch).
            use_base_weights = lang_key == "en"

            # Fix 3: Veterinary ASR domain biasing clamped strictly within
            # Whisper's decoder `max_target_positions` (448) so `prompt_ids` +
            # special prefix tokens (<|startoftranscript|>, <|lang|>,
            # <|transcribe|>, <|notimestamps|>) + `max_new_tokens` NEVER
            # exceeds 448 (root cause of HTTP 503 ValueError on ur audio).
            model_max_positions = int(
                getattr(getattr(model, "config", None), "max_target_positions", 448) or 448
            )
            decoder_prefix_reserve = 8
            configured_asr_cap = max(1, int(self._cfg.asr_max_new_tokens))
            max_prompt_tokens = max(
                0, min(180, model_max_positions - configured_asr_cap - decoder_prefix_reserve)
            )
            domain_prompt = build_whisper_initial_prompt(lang_key)
            prompt_ids = None
            get_prompt_ids = getattr(processor, "get_prompt_ids", None)
            if callable(get_prompt_ids) and max_prompt_tokens > 0:
                try:
                    raw_prompt_ids = get_prompt_ids(domain_prompt, return_tensors="pt")
                    if raw_prompt_ids is not None and len(raw_prompt_ids) > max_prompt_tokens:
                        raw_prompt_ids = raw_prompt_ids[:max_prompt_tokens]
                    if raw_prompt_ids is not None and len(raw_prompt_ids) > 0:
                        prompt_ids = raw_prompt_ids.to(device=model.device)
                except Exception:
                    prompt_ids = None
            prompt_len = int(len(prompt_ids)) if prompt_ids is not None else 0
            effective_asr_max_new_tokens = min(
                configured_asr_cap,
                max(1, model_max_positions - prompt_len - decoder_prefix_reserve),
            )

            def _decode_window(window: "np.ndarray") -> str:
                feats = processor.feature_extractor(
                    window,
                    sampling_rate=sample_rate,
                    return_attention_mask=True,
                    return_tensors="pt",
                )
                # max_new_tokens is the actively supported generate arg (the
                # exact recipe evaluate_asr.py used for the verified Stage-10
                # eval under the pinned stack); `max_length` is the deprecated
                # Whisper path. condition_on_prev_tokens=False is Fix 1: no
                # cross-chunk conditioning, so a pause or greeting can never
                # gate the rest of the note.
                gen_kwargs: Dict[str, Any] = {
                    "max_new_tokens": effective_asr_max_new_tokens,
                    "task": "transcribe",
                    "condition_on_prev_tokens": False,
                }
                if lang_whisper is not None:
                    gen_kwargs["language"] = lang_whisper
                if prompt_ids is not None:
                    gen_kwargs["prompt_ids"] = prompt_ids
                if getattr(feats, "attention_mask", None) is not None:
                    gen_kwargs["attention_mask"] = feats.attention_mask.to(model.device)
                with torch.no_grad():
                    if use_base_weights:
                        with model.disable_adapter():
                            ids = model.generate(
                                input_features=feats.input_features.to(
                                    device=model.device, dtype=model.dtype
                                ),
                                **gen_kwargs,
                            )
                    else:
                        ids = model.generate(
                            input_features=feats.input_features.to(
                                device=model.device, dtype=model.dtype
                            ),
                            **gen_kwargs,
                        )
                # clean_up_tokenization_spaces pinned EXPLICITLY to True: that
                # is the default the verified eval stack (4.48.3) measured,
                # and it keeps serving output consistent with the eval
                # pipeline even when a future transformers flips the default.
                decoded_text = processor.tokenizer.batch_decode(
                    ids, skip_special_tokens=True, clean_up_tokenization_spaces=True
                )[0].strip()
                # Owner reliability fix (2026-11-04): release the feature and
                # token tensors explicitly before returning so a long
                # multi-chunk consultation keeps a flat GPU/CPU memory profile.
                del feats, ids
                return decoded_text

            # Owner Fix 1: 20 s chunks (320,000 samples at 16 kHz) replace the
            # 30 s split - shorter chunks keep each decode inside the FLEURS
            # distribution the base model handles cleanly.
            chunk_len = 20 * int(sample_rate)
            chunks = [
                (start, min(start + chunk_len, speech.shape[0]))
                for start in range(0, speech.shape[0], chunk_len)
            ]
            chunk_count = len(chunks)
            decoded = []
            skipped_silent = 0
            # Owner reliability fix (2026-11-04): a long consultation is N
            # sequential 20 s decodes on ONE uvicorn worker — a per-chunk
            # failure must surface as a CONTROLLED error naming the chunk
            # (honest 503 JSON envelope via app.py's exception mapping), never
            # an uncaught worker crash; and every finished decode releases its
            # audio/feature tensors on CPU so a 13-minute upload cannot creep
            # the resident set into an OOM kill.
            is_cpu = state.get("device") == "cpu"
            for start, end in chunks:
                chunk = speech[start:end]
                # Silence gate: pure padding/room-tone chunks cost a full
                # decode for nothing - skip them and say so in the note.
                try:
                    is_silent = chunk.shape[0] == 0 or float(np.max(np.abs(chunk))) < 1e-3
                except Exception:
                    is_silent = False  # never let cleanup arithmetic break inference
                if is_silent:
                    skipped_silent += 1
                    del chunk
                    if is_cpu:
                        gc.collect()
                    continue
                try:
                    part_text = _decode_window(chunk)
                except ProviderError:
                    raise  # controlled errors keep their identity/status
                except Exception as chunk_err:
                    raise InferenceError(
                        f"Whisper decode failed on chunk [{start}:{end}] "
                        f"({chunk.shape[0]} samples, "
                        f"chunk {len(decoded) + skipped_silent + 1}/{chunk_count}): "
                        f"{type(chunk_err).__name__}: {chunk_err}. Controlled error — "
                        "no silent substitution (no Gemini fallback)."
                    ) from chunk_err
                if part_text:
                    decoded.append(part_text)
                # Eager release of THIS chunk's audio reference + a young-gen
                # sweep on CPU: flat resident memory across long consults.
                del chunk
                if is_cpu:
                    gc.collect()
            text = clean_asr_transcript(" ".join(decoded))
            if chunk_count == 0:
                note = "empty input audio"
            elif chunk_count == 1:
                note = "single-chunk transcription (input <= 20 s)"
            else:
                note = (
                    f"multi-chunk transcription: {chunk_count} x 20 s chunks joined (no "
                    f"overlap; {skipped_silent} silent chunk(s) skipped); a word straddling "
                    "a chunk boundary may clip"
                )
            return {
                "text": text,
                "language": lang_key,
                "sample_rate": sample_rate,
                "windows": chunk_count,
                "note": note,
            }
        except ProviderError:
            raise  # controlled errors keep their exact identity/status
        except Exception as err:
            raise InferenceError(
                f"ASR inference failed in this environment: {type(err).__name__}: {err}. "
                "Nothing was silently substituted (no Gemini fallback)."
            ) from err

    def draft(self, transcript: str, max_new_tokens: Optional[int] = None,
              note_format: str = VET_NOTE_FORMAT,
              cancel_event: Optional[Any] = None,
              progress_cb: Optional[Any] = None) -> Dict[str, Any]:
        try:
            if (note_format or "").strip().lower() not in VET_NOTE_FORMATS:
                raise InferenceError(
                    f"unsupported draft format {note_format!r}; allowed: "
                    "vet_scribenote | medscribe."
                )
            fmt = (note_format or "").strip().lower()
            # Owner budget fix (2026-11-05): resolve the device BEFORE loading
            # anything - on CPU the resident ASR Whisper is released here
            # (unconditionally) so its ~1.2-2 GB is free before any SOAP model
            # loads; the cold-load RAM peak is exactly when the 16 GB owner box
            # starts paging.
            device = self._resolve_device()
            is_cpu = device == "cpu"
            if is_cpu:
                self._release_asr_before_draft()
                gc.collect()
            # Owner fix (2026-11-19): vet_scribenote on CPU rides the quantized
            # GGUF base (~2.1 GB, llama.cpp AVX2 decode) through the SAME prompt
            # and the SAME deterministic hydration/guard pipeline; medscribe and
            # CUDA keep the exact torch/PEFT behaviour (envelope says which).
            backend = self._soap_backend_for(fmt, device)
            # 2026-10-31 local-speed: an explicit request-level cap wins
            # (validated 1..cfg cap at the API layer and echoed in the
            # envelope). None -> the configured cap, clamped tighter on CPU.
            # Owner Fix 2 (2026-11-01): the vet_scribenote shape got the 256 ->
            # 448 CPU clamp; owner budget realignment (2026-11-05) moved the
            # config default to 320. The clamp constants remain CEILINGS for
            # env-raised configurations - never a silent edit of the note.
            tokens_cap = self._cfg.draft_max_new_tokens
            if max_new_tokens is not None:
                tokens_cap = int(max_new_tokens)
            elif is_cpu:
                if backend == "gguf" and fmt == "vet_scribenote":
                    # Quantized GGUF runs 5-15x faster on CPU than bf16 torch,
                    # so full 5-minute consults can keep up to 640 tokens and
                    # finish Subjective + Objective + Assessment + Plan cleanly.
                    tokens_cap = min(640, tokens_cap)
                else:
                    tokens_cap = min(448 if fmt == "vet_scribenote" else 256, tokens_cap)

            if backend == "gguf":
                state = self._loaded["soap"]
                if state is not None and state.get("backend") != "gguf":
                    # a torch SOAP (medscribe) is resident - swap it out first;
                    # mixing backends in one slot would double the RAM footprint.
                    self.unload("soap")
                    state = None
                state = state or self._load_soap_gguf()
                raw_text = self._draft_gguf(
                    state,
                    transcript,
                    tokens_cap,
                    cancel_event=cancel_event,
                    progress_cb=progress_cb,
                )
                if cancel_event is not None and cancel_event.is_set():
                    raise DraftCancelled("draft cancelled by the operator")
                payload = self._finalize_vet_draft(raw_text, transcript, tokens_cap)
                payload["backend"] = "gguf"
                payload["gguf_model"] = state.get("model_file")
                # Honest provenance: a quantized BASE GGUF is NOT the unquantized
                # PEFT adapter the training manifest labels FULL - say so in-band
                # rather than letting the manifest label imply otherwise.
                payload["model_scale"] = (
                    f"FULL-BASE-GGUF({state.get('model_file')}; base weights - LoRA adapter "
                    "NOT applied; same vet_scribenote prompt + deterministic hydration)"
                )
                return payload

            # ---- legacy torch/PEFT path (medscribe parity + CUDA) ----------
            state = self._loaded["soap"]
            if state is not None and state.get("backend") == "gguf":
                self.unload("soap")
                state = None
            state = state or self._load_soap()
            torch = self._real_stack()
            model = state["model"]
            tok = state["tokenizer"]
            # return_dict=True is EXPLICIT: the unpinned Colab resolve revealed
            # that implicit template-return shape drifted across transformers
            # versions (raw Tensor -> BatchEncoding) and crashed the real
            # /draft gate with KeyError('shape'). Explicit + _unwrap_chat_prompt
            # accepts both shapes; the runtime itself is pinned in
            # requirements-serving-ml.txt.
            # Owner Fix 2 (2026-11-01): "vet_scribenote" DEFAULT runs the BASE
            # Qwen weights (model.disable_adapter()) - the medscribe soap-lora
            # adapter forces short human-medical summaries and cannot emit the
            # 23-parameter veterinary shape. "medscribe" keeps the EXACT
            # legacy behaviour (adapter enabled + configured system prompt).
            system_prompt = (
                self._cfg.soap_system_prompt if fmt == "medscribe" else VET_SCRIBENOTE_SYSTEM_PROMPT
            )
            prompt = tok.apply_chat_template(
                [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": transcript},
                ],
                tokenize=True,
                add_generation_prompt=True,
                return_tensors="pt",
                return_dict=True,
            )
            prompt_ids, prompt_mask = _unwrap_chat_prompt(prompt)
            gen_kwargs: Dict[str, Any] = {
                "input_ids": prompt_ids.to(model.device),
                "max_new_tokens": tokens_cap,
                "do_sample": False,
                "pad_token_id": tok.pad_token_id or tok.eos_token_id,
            }
            if prompt_mask is not None:
                gen_kwargs["attention_mask"] = prompt_mask.to(model.device)
            if cancel_event is not None or progress_cb is not None:
                gen_kwargs["stopping_criteria"] = self._torch_stopping_criteria(
                    cancel_event, progress_cb, int(prompt_ids.shape[-1])
                )
            if is_cpu:
                # Owner reliability fix (2026-11-04): bound the intra-op pool
                # for the LONG DRAFT so headroom stays for the uvicorn loop.
                # Owner budget fix (2026-11-05): default max(2, cpus-1) - ONE
                # logical core stays clear for the loop + Windows UI instead
                # of two. Env override: VOXSOAP_DRAFT_THREADS. Never UP-sizes:
                # an explicitly lower pool stays lower.
                cap_env = _boot_os.environ.get("VOXSOAP_DRAFT_THREADS", "").strip()
                draft_threads = (
                    max(1, int(cap_env))
                    if cap_env.isdigit()
                    else max(2, (_boot_os.cpu_count() or 4) - 1)
                )
                if torch.get_num_threads() > draft_threads:
                    torch.set_num_threads(draft_threads)
            # Owner budget fix (2026-11-05): inference_mode instead of
            # no_grad for the draft decode - it disables autograd version
            # counters/bookkeeping outright, a measurable CPU win on a
            # minute-scale generation loop; the draft path never touches
            # gradients afterwards.
            with torch.inference_mode():
                if fmt == "vet_scribenote":
                    with model.disable_adapter():
                        out = model.generate(**gen_kwargs)
                else:
                    out = model.generate(**gen_kwargs)
            if cancel_event is not None and cancel_event.is_set():
                raise DraftCancelled("draft cancelled by the operator")
            continuation = out[:, prompt_ids.shape[-1]:]
            # clean_up_tokenization_spaces pinned for the same reason as ASR:
            # frozen to the verified 4.48.3 default the eval pipeline measured.
            text = tok.batch_decode(
                continuation, skip_special_tokens=True, clean_up_tokenization_spaces=True
            )[0].strip()
            if fmt == "medscribe":
                return {
                    "draft": text,
                    "generation": "greedy",
                    "max_new_tokens": tokens_cap,
                    "backend": "torch",
                    "note": "assistive DRAFT - deterministic guard annotations attached; vet confirmation is mandatory",
                }
            # Owner Fix 2 post-processing: deterministically hydrate ALL 23
            # canonical objective parameters (missing -> "Not mentioned") and
            # ship both the formatted draft string and the structured sections
            # object the frontend maps into the main SOAP workspace cards.
            payload = self._finalize_vet_draft(text, transcript, tokens_cap)
            payload["backend"] = "torch"
            return payload
        except ProviderError:
            raise
        except DraftCancelled:
            raise
        except Exception as err:
            raise InferenceError(
                f"SOAP draft inference failed in this environment: {type(err).__name__}: {err}. "
                "Nothing was silently substituted (no Gemini fallback)."
            ) from err

    def roman(self, text: str) -> Dict[str, Any]:
        try:
            state = self._loaded["roman"] or self._load_roman()
            torch = self._real_stack()
            model = state["model"]
            tok = state["tokenizer"]
            ids = tok(TASK_PREFIX + text, return_tensors="pt", truncation=True, max_length=128)
            with torch.no_grad():
                out = model.generate(
                    input_ids=ids.input_ids.to(model.device),
                    max_new_tokens=self._cfg.roman_max_new_tokens,
                    num_beams=1,
                    do_sample=False,
                )
            roman = tok.batch_decode(
                out, skip_special_tokens=True, clean_up_tokenization_spaces=True
            )[0].strip()
            return {"roman": roman, "task_prefix": TASK_PREFIX}
        except ProviderError:
            raise
        except Exception as err:
            raise InferenceError(
                f"Roman inference failed in this environment: {type(err).__name__}: {err}. "
                "Nothing was silently substituted (no Gemini fallback)."
            ) from err

    # ---------- unload / swap (Windows RAM safeguard) ----------

    def unload(self, key: str) -> bool:
        if key not in self._loaded or self._loaded[key] is None:
            return False
        self._loaded[key] = None
        gc.collect()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass  # no torch in this process - CPU refs are already dropped
        return True


class GeminiProxyProvider:
    """Passthrough to the EXISTING Gemini-backed processing service.

    Used only when a REQUEST explicitly selects provider="gemini" (or the
    configured default is gemini). If VOXSOAP_GEMINI_PROXY_URL is unset the
    provider answers honest 501; it NEVER falls back to or from the ML path.
    """

    name = "gemini"
    is_mock = False

    def __init__(self, cfg: Any):
        self._cfg = cfg

    def _post_task(self, task: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        if not self._cfg.gemini_proxy_url:
            raise NotConfigured(
                "VOXSOAP_GEMINI_PROXY_URL is not set - the Gemini proxy path is not configured. "
                "This is an honest 501 (no silent ML fallback, and the ML path did not fail here)."
            )
        try:
            import httpx
        except Exception as err:
            raise InferenceError(f"httpx is unavailable in this Python environment: {err}") from err
        body = {"task": task, "payload": payload, "client": "voxsoap-ml-serving"}
        try:
            response = httpx.post(self._cfg.gemini_proxy_url, json=body, timeout=120.0)
        except Exception as err:
            raise InferenceError(
                f"Gemini proxy unreachable ({type(err).__name__}): {err}"
            ) from err
        if response.status_code >= 400:
            raise InferenceError(
                f"Gemini proxy returned HTTP {response.status_code}",
                detail={"upstream_status": response.status_code, "upstream_body": response.text[:500]},
            )
        try:
            return response.json()
        except ValueError:
            return {"raw_upstream_body": response.text[:2000]}

    def scale_for(self, key: str) -> Tuple[str, str]:
        return "NOT_APPLICABLE(gemini proxy carries no local voxsoap ml weights)", "provider_type"

    def describe(self) -> Dict[str, Any]:
        return {
            "proxy_url_set": bool(self._cfg.gemini_proxy_url),
            "is_mock": self.is_mock,
        }

    def transcribe(self, samples, sample_rate: int, audio_bytes: Optional[bytes] = None,
                   language: str = "ur") -> Dict[str, Any]:
        payload = {
            "audio_b64": base64.b64encode(audio_bytes or b"").decode("ascii"),
            "sample_rate": sample_rate,
            "language": (language or "ur"),
            "note": "passthrough to the existing Gemini-backed speech service",
        }
        return self._post_task("transcribe", payload)

    def draft(self, transcript: str, max_new_tokens: Optional[int] = None,
              note_format: str = "vet_scribenote") -> Dict[str, Any]:
        payload: Dict[str, Any] = {"transcript": transcript}
        if max_new_tokens is not None:
            payload["max_new_tokens"] = max_new_tokens
        if note_format:
            payload["format"] = note_format
        return self._post_task("draft", payload)

    def roman(self, text: str) -> Dict[str, Any]:
        return self._post_task("roman", {"text": text})

    def unload(self, key: str) -> bool:
        return False  # the proxy holds no local model state


def deepcopy_unloaded(ml_provider: MLProvider) -> MLProvider:
    """Swap helper: returns a same-config MLProvider with everything unloaded.

    This exists so an operator/logging tool can prove that a cloned container
    holds no loaded weights; the real RAM swap in this scaffold is simply
    POST /unload (+ optionally restarting with new VOXSOAP_*_ADAPTER_DIR env).
    """
    clone = MLProvider(ml_provider._cfg)
    assert clone._loaded == {k: None for k in COMPONENT_KEYS}
    return clone
