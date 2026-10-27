"""POST /draft contract - mocked provider + deterministic guard (NOT real inference)."""
from __future__ import annotations

from conftest import FakeMLProvider


def test_draft_happy_with_deterministic_guard(app, client):
    fake = FakeMLProvider()
    app.state.container.ml = fake
    r = client.post("/draft", json={"transcript": "Patient coughing for 3 days. Temperature 38.5."})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["provider"] == "ml"
    assert body["serving_mode"] == "mocked-test-double"
    assert body["draft"].startswith("SUBJECTIVE")
    guard = body["guard"]
    assert guard["schema"]["complete_schema"] is True
    # deterministic guard annotations (ported from evaluate_soap.py rules):
    assert guard["facts"]["unsupported_numbers_in_draft"] == ["25"]      # 25 mg is NOT in source
    assert "mg" in guard["facts"]["unsupported_med_tokens_in_draft"]
    assert guard["facts"]["numbers_from_source_missing_in_draft"] == []
    assert "not stated" in guard["unstated_markers_used_in_draft"]
    assert "NOT a clinical-safety verdict" in guard["review_hint"]


def test_draft_rejects_empty_transcript(app, client):
    app.state.container.ml = FakeMLProvider()
    r = client.post("/draft", json={"transcript": "   "})
    assert r.status_code == 400
    body = r.json()
    assert body["error"] == "bad_request"
    assert body["provider"] == "ml"
    assert "model_scale" in body


def test_draft_rejects_oversize_transcript(app, client):
    app.state.container.ml = FakeMLProvider()
    r = client.post("/draft", json={"transcript": "a" * 14001})
    assert r.status_code == 400
    body = r.json()
    assert "14000" in body["message"]
