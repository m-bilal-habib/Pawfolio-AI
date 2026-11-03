"""Owner Fix 2 + Fix 4 (2026-11-01): the vet_scribenote draft contract.

Mocked, deterministic: the hydrated sections are produced by the REAL
post-processing pipeline in providers.py (`_vet_hydrated_story` / `_vet_parse_objective`)
fed with the SAME base-Qwen output shape the live model produces for the
"Leo ear infection" consultation. The Leo content gate mirrors the owner's
acceptance checklist exactly:
  - Subjective: 3.5 yo canine, 3 days head shaking / scratching right ear /
    whimpering / odor, groomer bath 1 week ago, summer skin allergies on
    Apoquel.
  - Objective: all 23 canonical params, Weight 24.5 kg + red/inflamed right
    ear populated, remaining 21 = "Not mentioned".
  - Assessment: acute otitis externa right ear secondary to moisture after
    bath + due for vaccinations.
  - Plan: DHPP + Rabies today, daily ear cleaner, Posatex 4 drops right ear
    OD x7d, 10-day recheck.
The API-level tests pin the /draft `format` routing contract.
"""
from __future__ import annotations

from conftest import FakeMLProvider
from providers import (
    VET_NOTE_FORMAT,
    VET_NOTE_FORMATS,
    VET_OBJECTIVE_PARAMS,
    _vet_hydrated_story,
)


# The base-weights Qwen2.5-3B output shape for the Leo consultation vet prompt
# (model states ONLY what the transcript explicitly contains - it never writes
# "Not mentioned" itself; Python hydration fills those).
LEO_MODEL_OUTPUT = """SUBJECTIVE:
Leo is a 3.5-year-old male canine presenting with a 3-day history of head shaking, scratching at the right ear, whimpering episodes, and a noticeable odor from the right ear. The owner bathed him at the groomer about one week ago. He has a past history of skin allergies in the summer, previously treated with Apoquel.

OBJECTIVE_MENTIONED:
Weight: 24.5 kg
Ears: The right ear canal is very red and inflamed with a foul odor and some debris.

ASSESSMENT:
- Acute otitis externa of the right ear, secondary to moisture retention after the recent bath.
- Patient is due for vaccinations.

PLAN:
- Administer DHPP and Rabies vaccines today.
- Continue with daily ear cleaner at home.
- Posatex: 4 drops into the right ear once daily for 7 days.
- Recheck in 10 days.
"""


def _leo_hydrated():
    return _vet_hydrated_story(LEO_MODEL_OUTPUT)


def test_canonical_objective_params_exact_owner_order():
    assert VET_OBJECTIVE_PARAMS == (
        "Temperature", "Heart Rate", "Weight", "Respiratory Rate",
        "Capillary Refill Time", "Mucous Membranes", "Hydration Status",
        "Body Condition Score", "Pain Score", "Fear Anxiety Stress Score",
        "Eyes", "Ears", "Nasal", "Oral/Dental", "Cardiovascular", "Respiratory",
        "Neurological", "Musculoskeletal", "Lymphatic", "Gastrointestinal",
        "Reproductive/Urinary", "Integument", "Masses",
    )
    assert len(VET_OBJECTIVE_PARAMS) == 23


def test_leo_subjective_gate():
    _, sections, _, _ = _leo_hydrated()
    s = sections["subjective"]
    assert "3.5-year-old" in s
    assert "canine" in s
    assert "3-day history" in s
    for sign in ("head shaking", "scratching at the right ear", "whimpering", "odor"):
        assert sign in s, sign
    assert "groomer about one week ago" in s
    assert "skin allergies in the summer" in s
    assert "Apoquel" in s


def test_leo_objective_hydrated_exactly_23_in_order():
    _, sections, _, _ = _leo_hydrated()
    obj = sections["objective_map"]
    assert list(obj.keys()) == list(VET_OBJECTIVE_PARAMS)  # count AND order
    assert obj["Weight"] == "24.5 kg"
    assert "red and inflamed" in obj["Ears"]
    mentioned = {name for name, value in obj.items() if value != "Not mentioned"}
    assert mentioned == {"Weight", "Ears"}  # the other 21 are exactly "Not mentioned"


def test_leo_assessment_and_plan_bullets():
    _, sections, _, _ = _leo_hydrated()
    assessment = sections["assessment"]
    assert assessment.count("- ") >= 2
    assert "acute otitis externa" in assessment.lower()
    assert "moisture" in assessment.lower()
    assert "vaccinations" in assessment.lower()
    plan = sections["plan"]
    assert "DHPP" in plan and "Rabies" in plan
    assert "ear cleaner" in plan
    assert "Posatex" in plan and "4 drops" in plan and "7 days" in plan
    assert "Recheck in 10 days" in plan


def test_hydrated_draft_text_carries_every_section_and_param():
    draft_text, sections, unknown, _ = _leo_hydrated()
    for header in ("SUBJECTIVE:", "OBJECTIVE_MENTIONED:", "ASSESSMENT:", "PLAN:"):
        assert header in draft_text
    assert "Ears: The right ear canal is very red and inflamed" in draft_text
    assert "Temperature: Not mentioned" in draft_text
    assert "Fear Anxiety Stress Score: Not mentioned" in draft_text
    assert unknown == 0


def test_model_that_writes_not_mentioned_is_overridden_deterministically():
    # Even if the model disobeys and writes "Not mentioned" itself, hydration
    # keeps the canonical value stable (the string it emitted IS the fill).
    raw = "OBJECTIVE_MENTIONED:\nTemperature: Not mentioned\nWeight: 24.5 kg"
    _, sections, _, _ = _vet_hydrated_story("SUBJECTIVE:\nA short history.\n\n" + raw)
    assert sections["objective_map"]["Temperature"] == "Not mentioned"
    assert sections["objective_map"]["Weight"] == "24.5 kg"


def test_bare_model_placeholders_collapse_to_not_mentioned():
    # Live-probe lesson (2026-11-03): the base-weights 3B model filled unstated
    # parameters with "not examined"/"Normal"-style placeholders, breaking the
    # "21 of 23 Not mentioned" contract. Deterministic fix: a bare non-data
    # token hydrates to the canonical fill; a value with real spoken content
    # ("24.5 kg", "very red and inflamed") survives verbatim.
    raw = (
        "SUBJECTIVE:\nA short history.\n\n"
        "OBJECTIVE_MENTIONED:\n"
        "Temperature: not examined\n"
        "Heart Rate: Normal\n"
        "Mucous Membranes: WNL\n"
        "Respiratory Rate: N/A\n"
        "Integument: None\n"
        "Weight: 24.5 kg\n"
        "Ears: The right ear canal is very red and inflamed\n\n"
        "ASSESSMENT:\n- acute otitis externa\n\n"
        "PLAN:\n- recheck in 10 days"
    )
    _, sections, unknown, _ = _vet_hydrated_story(raw)
    assert unknown == 0
    obj = sections["objective_map"]
    for param in ("Temperature", "Heart Rate", "Mucous Membranes", "Respiratory Rate", "Integument"):
        assert obj[param] == "Not mentioned", f"{param}: {obj[param]!r}"
    assert obj["Weight"] == "24.5 kg"
    assert obj["Ears"] == "The right ear canal is very red and inflamed"
    hydrated_value_text = sections["objective_text"]
    assert "Temperature: Not mentioned" in hydrated_value_text
    assert "Weight: 24.5 kg" in hydrated_value_text


def test_untraceable_objective_values_drop_with_transcript_trace():
    # 2026-11-03 live probe: the base-3B model stated unstated parameters
    # ("Mucous Membranes: pink and moist"). Serving-path contract: a stated
    # VALUE with no verbatim token trace in the consultation transcript is
    # a model invention and drops deterministically to "Not mentioned"
    # (FR-27 mirror: untraceable claims are dropped, never rewritten); real
    # spoken data survives the same gate. Units are stopwords ("kg" never
    # gates a value the transcript phrases differently).
    leo_transcript = (
        "He weighs 24.5 kg. The right ear canal is very red and inflamed. "
        "The left ear looks clean and normal."
    )
    raw = (
        "SUBJECTIVE:\nHistory.\n\n"
        "OBJECTIVE_MENTIONED:\n"
        "Weight: 24.5 kg\n"
        "Ears: The right ear canal is very red and inflamed\n"
        "Mucous Membranes: pink and moist\n"
        "Heart Rate: 112 bpm\n\n"
        "ASSESSMENT:\n- acute otitis externa\n\n"
        "PLAN:\n- recheck in 10 days"
    )
    draft_text, sections, unknown, drops = _vet_hydrated_story(raw, transcript=leo_transcript)
    assert unknown == 0
    obj = sections["objective_map"]
    assert obj["Weight"] == "24.5 kg"                      # "24.5" traced
    assert "red and inflamed" in obj["Ears"]               # owner-contract param
    assert obj["Mucous Membranes"] == "Not mentioned"      # invented value
    assert obj["Heart Rate"] == "Not mentioned"            # invented number
    assert drops == 2
    assert "Mucous Membranes: Not mentioned" in sections["objective_text"]
    assert "Heart Rate: Not mentioned" in sections["objective_text"]
    # Without a transcript the gate is inert (pure unit path): values are
    # hydrated verbatim, zero drops.
    _, sections_nt, _, drops_nt = _vet_hydrated_story(raw)
    assert sections_nt["objective_map"]["Mucous Membranes"] == "pink and moist"
    assert sections_nt["objective_map"]["Heart Rate"] == "112 bpm"
    assert drops_nt == 0


def test_alias_matching_covers_common_variants():
    raw = (
        "SUBJECTIVE:\nHistory.\n\n"
        "OBJECTIVE_MENTIONED:\n"
        "- Temp: 102.5 F\n"
        "- Ear canal: brown debris, inflamed\n"
        "- FAS: 3/4\n"
        "- Skin: erythematous macule on ventral abdomen\n"
        "- HR: 112 bpm\n\n"
        "ASSESSMENT:\n- x\n\nPLAN:\n- y"
    )
    _, sections, unknown, _ = _vet_hydrated_story(raw)
    assert unknown == 0
    obj = sections["objective_map"]
    assert obj["Temperature"] == "102.5 F"
    assert obj["Ears"] == "brown debris, inflamed"
    assert obj["Fear Anxiety Stress Score"] == "3/4"
    assert obj["Integument"] == "erythematous macule on ventral abdomen"
    assert obj["Heart Rate"] == "112 bpm"


def test_no_heading_fallback_keeps_raw_as_subjective():
    raw = "Leo: 3.5 y canine. Head shaking for 3 days."
    draft_text, sections, unknown, _ = _vet_hydrated_story(raw)
    assert sections["subjective"] == raw
    assert set(sections["objective_map"]) == set(VET_OBJECTIVE_PARAMS)
    assert all(v == "Not mentioned" for v in sections["objective_map"].values())
    assert unknown == 0


def test_multiline_objective_value_survives_continuation_lines():
    raw = (
        "SUBJECTIVE:\nHistory.\n\n"
        "OBJECTIVE_MENTIONED:\n"
        "Ears: The right ear canal is very red and inflamed\n"
        "with a foul odor and debris\n\n"
        "ASSESSMENT:\n- acute otitis externa\n\n"
        "PLAN:\n- recheck 10 days"
    )
    _, sections, unknown, _ = _vet_hydrated_story(raw)
    assert unknown == 0
    assert sections["objective_map"]["Ears"] == (
        "The right ear canal is very red and inflamed with a foul odor and debris"
    )


def test_draft_format_values_contract():
    assert VET_NOTE_FORMAT == "vet_scribenote"
    assert VET_NOTE_FORMATS == ("vet_scribenote", "medscribe")


def test_draft_default_format_is_vet_scribenote_and_echoed(app, client):
    fake = FakeMLProvider()
    app.state.container.ml = fake
    r = client.post("/draft", json={"transcript": "SUBJECTIVE: 5 mg daily noted. PLAN: continue."})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["format"] == "vet_scribenote"
    assert fake.calls[0][3] == "vet_scribenote"
    assert set(body["sections"]) == {
        "subjective", "objective_map", "objective_text", "assessment", "plan",
    }


def test_draft_medscribe_format_is_forwarded(app, client):
    fake = FakeMLProvider()
    app.state.container.ml = fake
    r = client.post(
        "/draft",
        json={"transcript": "SUBJECTIVE: 5 mg daily noted. PLAN: continue.", "format": "medscribe"},
    )
    assert r.status_code == 200, r.text
    assert fake.calls[0][3] == "medscribe"


def test_draft_unknown_format_is_honest_400(app, client):
    app.state.container.ml = FakeMLProvider()
    r = client.post(
        "/draft",
        json={"transcript": "SUBJECTIVE: 5 mg daily noted. PLAN: continue.", "format": "klingon"},
    )
    assert r.status_code == 400, r.text
    body = r.json()
    assert body["error"] == "bad_request"
    assert "vet_scribenote" in body["message"]
