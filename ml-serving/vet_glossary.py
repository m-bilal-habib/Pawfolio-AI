"""Shared veterinary domain glossary, Whisper biasing prompts, and deterministic drug/allergy resolver."""
from __future__ import annotations

import re
from difflib import SequenceMatcher
from typing import Any, Dict, List, Optional, Tuple


VET_DRUG_CATALOG: Tuple[Dict[str, Any], ...] = (
    {
        "canonical_name": "Posatex Otic Suspension",
        "aliases": ("Posatex", "Posatex ear drops", "Posatex drops", "Orbifloxacin Mometasone Posaconazole"),
        "ingredient_class": "Orbifloxacin / Mometasone / Posaconazole",
        "default_route": "otic (ear)",
        "allergy_classes": ("fluoroquinolone", "steroid"),
    },
    {
        "canonical_name": "Epi-Otic Advanced Ear Cleaner",
        "aliases": ("Epi-Otic", "EpiOtic", "daily ear cleaner", "medicated ear cleaner"),
        "ingredient_class": "Salicylic Acid Otic Cleanser",
        "default_route": "otic (ear)",
        "allergy_classes": ("salicylate",),
    },
    {
        "canonical_name": "Apoquel 16mg Chewable",
        "aliases": ("Apoquel", "Apoquel 16mg", "Apoquel 16 mg", "Oclacitinib"),
        "ingredient_class": "JAK Inhibitor",
        "default_route": "oral",
        "allergy_classes": ("jak inhibitor",),
        "contains_animal_protein": True,
    },
    {
        "canonical_name": "Clavamox Drops / Tablets",
        "aliases": ("Clavamox", "Amoxicillin-Clavulanate", "Amoxicillin Clavulanate", "Augmentin"),
        "ingredient_class": "Penicillin / Beta-Lactam",
        "default_route": "oral",
        "allergy_classes": ("penicillin", "beta-lactam", "amoxicillin"),
    },
    {
        "canonical_name": "Metacam Oral Suspension",
        "aliases": ("Metacam", "Meloxicam"),
        "ingredient_class": "NSAIDs / Meloxicam",
        "default_route": "oral",
        "allergy_classes": ("nsaid", "nsaids", "meloxicam"),
    },
    {
        "canonical_name": "Simplicef (Cefpodoxime Proxetil)",
        "aliases": ("Simplicef", "Cefpodoxime", "Cefpodoxime Proxetil"),
        "ingredient_class": "Cephalosporin / Beta-Lactam Cross-Reactive",
        "default_route": "oral",
        "allergy_classes": ("cephalosporin", "beta-lactam"),
    },
    {
        "canonical_name": "Terramycin Ophthalmic Ointment",
        "aliases": ("Terramycin", "Terramycin eye ointment", "Oxytetracycline"),
        "ingredient_class": "Tetracycline Ophthalmic",
        "default_route": "ophthalmic",
        "allergy_classes": ("tetracycline",),
    },
    {
        "canonical_name": "Rimadyl (Carprofen)",
        "aliases": ("Rimadyl", "Carprofen", "Carprofen chewable"),
        "ingredient_class": "NSAIDs / Carprofen",
        "default_route": "oral",
        "allergy_classes": ("nsaid", "nsaids", "carprofen"),
        "contains_animal_protein": True,
    },
    {
        "canonical_name": "Gabapentin",
        "aliases": ("Gabapentin", "Neurontin"),
        "ingredient_class": "Gabapentinoid Analgesic",
        "default_route": "oral",
        "allergy_classes": ("gabapentin",),
    },
    {
        "canonical_name": "Semintra Oral Solution",
        "aliases": ("Semintra", "Telmisartan"),
        "ingredient_class": "Angiotensin Receptor Blocker",
        "default_route": "oral",
        "allergy_classes": ("arb", "telmisartan"),
    },
    {
        "canonical_name": "Revolution Plus",
        "aliases": ("Revolution Plus", "Revolution", "Selamectin", "Sarolaner"),
        "ingredient_class": "Isoxazoline / Avermectin Parasiticide",
        "default_route": "topical",
        "allergy_classes": ("isoxazoline", "selamectin"),
    },
    {
        "canonical_name": "Cerenia (Maropitant)",
        "aliases": ("Cerenia", "Maropitant", "Maropitant citrate"),
        "ingredient_class": "NK-1 Receptor Antagonist Antiemetic",
        "default_route": "oral / subcutaneous",
        "allergy_classes": ("maropitant",),
    },
    {
        "canonical_name": "Metronidazole",
        "aliases": ("Metronidazole", "Flagyl"),
        "ingredient_class": "Nitroimidazole Antibiotic",
        "default_route": "oral",
        "allergy_classes": ("metronidazole", "nitroimidazole"),
    },
    {
        "canonical_name": "FortiFlora Probiotic",
        "aliases": ("FortiFlora", "Purina FortiFlora", "Fortiflora probiotic"),
        "ingredient_class": "Probiotic Supplement",
        "default_route": "oral (top-dressed)",
        "allergy_classes": (),
        "contains_animal_protein": True,
    },
    {
        "canonical_name": "Sulfadimethoxine (Albon)",
        "aliases": ("Sulfadimethoxine", "Albon", "TMS", "Trimethoprim-Sulfa", "Sulfa"),
        "ingredient_class": "Sulfonamides",
        "default_route": "oral",
        "allergy_classes": ("sulfonamide", "sulfonamides", "sulfa"),
    },
)

VET_APPROVED_VACCINES = ("DHPP", "Bordetella", "Leptospirosis", "FVRCP", "Rabies")
VET_ALLERGY_CLASSES = (
    "Sulfonamides",
    "Penicillin",
    "Beta-Lactam",
    "NSAIDs",
    "Carprofen",
    "Chicken protein",
    "Beef protein",
)

# Concise domain-biasing prompts kept strictly under 180 Whisper tokens (~145-165 tokens).
_WHISPER_EN_PROMPT = (
    "Vet SOAP: otitis externa, conjunctival hyperemia, serous discharge, erythematous, "
    "gingivitis, auscultation, palpation, subcutaneous, borborygmi, CRT. Vaccines: DHPP, "
    "Bordetella, Leptospirosis, FVRCP, Rabies. Allergies: Sulfonamides, Penicillin, NSAIDs, "
    "Carprofen. Drugs: Simplicef, cefpodoxime, Terramycin, ophthalmic, Rimadyl, Gabapentin, "
    "Posatex, Epi-Otic, Clavamox, Metacam, Apoquel, Semintra, Revolution Plus, Cerenia, "
    "Metronidazole, FortiFlora."
)

_WHISPER_UR_BI_PROMPT = (
    "Urdu-English vet visit: doktor sahab, bukhar, khansi, ulti, dast, kharish, kaan, aankh, "
    "otitis externa, conjunctival hyperemia, serous discharge, erythematous, gingivitis, "
    "auscultation, palpation, subcutaneous, borborygmi, CRT. Vaccines: DHPP, Bordetella, "
    "Leptospirosis, FVRCP, Rabies. Allergies: Sulfonamides, Penicillin, NSAIDs, Carprofen. "
    "Drugs: Simplicef, cefpodoxime, Terramycin, Rimadyl, Gabapentin, Posatex, Epi-Otic, "
    "Clavamox, Metacam, Apoquel, Semintra, Revolution Plus, Cerenia, Metronidazole, FortiFlora."
)


def build_whisper_initial_prompt(language: str) -> str:
    """Build a concise (< 180 Whisper tokens) domain-biasing initial_prompt."""
    lang = (language or "ur").strip().lower()
    if lang == "en":
        return _WHISPER_EN_PROMPT
    return _WHISPER_UR_BI_PROMPT


def clean_asr_transcript(text: str) -> str:
    """Lightweight structural post-ASR cleanup with zero speculative clinical rewriting."""
    if not text:
        return ""
    cleaned = re.sub(r"[ \t]+", " ", text).strip()
    cleaned = re.sub(r"\s+([,.;?!])", r"\1", cleaned)
    cleaned = re.sub(r"([,.;])\s*\1+", r"\1", cleaned)
    cleaned = re.sub(
        r"(?:(?<=^)|(?<=\n)|(?<=[.?!]\s))\b(doctor|dr|vet|veterinarian|owner|pet owner)\s*:\s*",
        lambda m: f"{m.group(1).title()}: ",
        cleaned,
        flags=re.IGNORECASE,
    )
    return re.sub(r"\n{3,}", "\n\n", cleaned).strip()


def _phonetic_key(raw: str) -> str:
    """Deterministic Double-Metaphone-inspired phonetic skeleton tuned for vet pharmacology."""
    s = re.sub(r"[^a-z0-9]", "", (raw or "").lower())
    if not s:
        return ""
    # Common vet ASR phonetic equivalences (e.g. Kef Podoxyme -> cefpodoxime, ph->f)
    replacements = (
        ("ph", "f"),
        ("kef", "sef"),
        ("cef", "sef"),
        ("ci", "si"),
        ("ce", "se"),
        ("cy", "si"),
        ("c", "k"),
        ("q", "k"),
        ("x", "ks"),
        ("z", "s"),
        ("y", "i"),
        ("wh", "w"),
        ("sh", "s"),
        ("ch", "k"),
        ("th", "t"),
        ("mycin", "misin"),
        ("myzin", "misin"),
        ("brizin", "misin"),
    )
    for src, dst in replacements:
        s = s.replace(src, dst)
    # Collapse consecutive duplicate characters
    deduped = []
    for ch in s:
        if not deduped or deduped[-1] != ch:
            deduped.append(ch)
    s = "".join(deduped)
    if len(s) <= 2:
        return s
    # Keep first char plus consonant skeleton so vowel shifts weigh less phonetically
    return s[0] + re.sub(r"[aeiou]", "", s[1:])


def _levenshtein_similarity(a: str, b: str) -> float:
    s1 = re.sub(r"[^a-z0-9]+", "", (a or "").lower())
    s2 = re.sub(r"[^a-z0-9]+", "", (b or "").lower())
    if not s1 or not s2:
        return 0.0
    if s1 == s2:
        return 1.0
    la, lb = len(s1), len(s2)
    prev = list(range(lb + 1))
    for i, ca in enumerate(s1, start=1):
        curr = [i]
        for j, cb in enumerate(s2, start=1):
            cost = 0 if ca == cb else 1
            curr.append(min(curr[-1] + 1, prev[j] + 1, prev[j - 1] + cost))
        prev = curr
    return 1.0 - (prev[-1] / max(la, lb, 1))


def _composite_drug_similarity(spoken: str, candidate: str) -> float:
    spoken_norm = re.sub(r"[^a-z0-9]+", "", (spoken or "").lower())
    cand_norm = re.sub(r"[^a-z0-9]+", "", (candidate or "").lower())
    if not spoken_norm or not cand_norm:
        return 0.0
    if spoken_norm == cand_norm:
        return 1.0
    lev = _levenshtein_similarity(spoken_norm, cand_norm)
    seq = SequenceMatcher(None, spoken_norm, cand_norm).ratio()
    phon_a = _phonetic_key(spoken)
    phon_b = _phonetic_key(candidate)
    phon_sim = _levenshtein_similarity(phon_a, phon_b) if phon_a and phon_b else 0.0
    # Slight boost when the longer term clearly embeds a brand/generic token (>=5 chars)
    if len(spoken_norm) >= 5 and (spoken_norm in cand_norm or cand_norm in spoken_norm):
        return round(min(0.95, max(lev, seq, 0.85)), 3)
    return round(0.45 * lev + 0.20 * seq + 0.35 * phon_sim, 3)


def check_allergy_conflict(
    entry: Dict[str, Any], known_allergies: Optional[List[str]]
) -> Optional[str]:
    if not known_allergies:
        return None
    classes = [c.lower() for c in entry.get("allergy_classes", ())]
    ing = str(entry.get("ingredient_class", "")).lower()
    name = str(entry.get("canonical_name", "")).lower()
    for raw_allergy in known_allergies:
        allergy = (raw_allergy or "").strip().lower()
        if not allergy:
            continue
        if (
            allergy in ing
            or allergy in name
            or any(allergy in c or c in allergy for c in classes)
        ):
            return f"Documented allergy '{raw_allergy}' conflicts with {entry['ingredient_class']}."
        if ("chicken" in allergy or "beef" in allergy or "protein" in allergy) and entry.get(
            "contains_animal_protein"
        ):
            return (
                f"Documented food sensitivity '{raw_allergy}' may conflict with flavored chewable/"
                f"protein base in {entry['canonical_name']} — verify hypoallergenic formulation."
            )
    return None


def resolve_drug_name(
    spoken_name: str, known_allergies: Optional[List[str]] = None
) -> Dict[str, Any]:
    """Two-stage deterministic fuzzy + phonetic catalog resolver with 3 confidence tiers.

    Tiers:
      - >= 0.80: High confidence (MATCH / MISMATCH on allergy)
      - 0.55 - 0.79: Medium confidence (NEEDS_REVIEW — "Needs Confirmation — Did you mean ...?")
      - < 0.55: Low confidence (UNKNOWN — preserves `[UNVERIFIED DRUG: "<verbatim>"]`, no substitute)
    """
    verbatim = (spoken_name or "").strip()
    if not verbatim:
        return {
            "verbatim": "",
            "tier": "low",
            "status": "UNKNOWN",
            "score": 0.0,
            "matched_canonical": None,
            "ingredient_class": None,
            "display_label": '[UNVERIFIED DRUG: ""]',
            "prompt_text": None,
            "allergy_conflict": None,
            "blocks_confirmation": True,
        }

    best_entry: Optional[Dict[str, Any]] = None
    best_score = 0.0
    for entry in VET_DRUG_CATALOG:
        candidates = (entry["canonical_name"], *entry["aliases"])
        score = max(_composite_drug_similarity(verbatim, cand) for cand in candidates)
        if score > best_score:
            best_score = score
            best_entry = entry

    allergy_reason = check_allergy_conflict(best_entry, known_allergies) if best_entry else None

    if best_entry and best_score >= 0.80:
        return {
            "verbatim": verbatim,
            "tier": "high",
            "status": "MISMATCH" if allergy_reason else "MATCH",
            "score": round(best_score, 2),
            "matched_canonical": best_entry["canonical_name"],
            "ingredient_class": best_entry["ingredient_class"],
            "display_label": best_entry["canonical_name"],
            "prompt_text": None,
            "allergy_conflict": allergy_reason,
            "blocks_confirmation": bool(allergy_reason),
        }

    if best_entry and best_score >= 0.55:
        return {
            "verbatim": verbatim,
            "tier": "medium",
            "status": "NEEDS_REVIEW",
            "score": round(best_score, 2),
            "matched_canonical": best_entry["canonical_name"],
            "ingredient_class": best_entry["ingredient_class"],
            "display_label": verbatim,
            "prompt_text": f"Needs Confirmation — Did you mean {best_entry['canonical_name']}?",
            "allergy_conflict": allergy_reason,
            "blocks_confirmation": True,
        }

    return {
        "verbatim": verbatim,
        "tier": "low",
        "status": "UNKNOWN",
        "score": round(best_score, 2),
        "matched_canonical": None,
        "ingredient_class": None,
        "display_label": f'[UNVERIFIED DRUG: "{verbatim}"]',
        "prompt_text": f'[UNVERIFIED DRUG: "{verbatim}"] — manual clinician entry required.',
        "allergy_conflict": None,
        "blocks_confirmation": True,
    }
