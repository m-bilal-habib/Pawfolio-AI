"""/health contract - mocked run (no model loading, no torch)."""
from __future__ import annotations


def test_health_ok(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["phase"] == "4-scaffold"
    assert body["default_provider"] == "ml"
    assert body["providers"]["ml"]["is_mock"] is False          # real provider object present
    assert body["providers"]["gemini"]["proxy_url_set"] is False
    assert body["providers"]["gemini"]["note"] and "501" in body["providers"]["gemini"]["note"]


def test_health_model_scale_labels_are_explicit(client):
    r = client.get("/health")
    body = r.json()
    scale = body["model_scale"]
    assert set(scale) == {"asr", "soap", "roman"}
    # Phase-2 artifacts predate the model_scale tag -> honestly derived.
    assert scale["asr"].startswith("SMOKE(assumed")
    assert scale["soap"].startswith("SMOKE(assumed")
    # Model C is not trained/exported yet.
    assert scale["roman"].startswith("UNKNOWN")


def test_health_policy_block(client):
    r = client.get("/health")
    body = r.json()
    assert body["policy"]["silent_gemini_fallback"] == "never - ML failure returns a controlled 5xx"
    assert "lazy" in body["policy"]["model_loading"]
    assert "unload" in body["policy"]["unload_helper"]
