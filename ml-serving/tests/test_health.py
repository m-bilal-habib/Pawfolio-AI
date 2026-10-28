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
    # Run-9 artifacts carry the tag directly in their training manifests.
    assert scale["asr"] == "FULL"
    assert scale["soap"] == "FULL"
    # Model C: the run-9 adapter FAILED its eval, so the serving default stays
    # unset -> honest UNKNOWN label (see test_scale_labels.py for the
    # pre-tag/derivation rules themselves).
    assert scale["roman"].startswith("UNKNOWN")


def test_health_policy_block(client):
    r = client.get("/health")
    body = r.json()
    assert body["policy"]["silent_gemini_fallback"] == "never - ML failure returns a controlled 5xx"
    assert "lazy" in body["policy"]["model_loading"]
    assert "unload" in body["policy"]["unload_helper"]


def test_health_reports_run9_adapter_files(client):
    r = client.get("/health")
    comps = r.json()["providers"]["ml"]["components"]
    assert comps["asr"]["adapter_files_present"] is True
    assert comps["soap"]["adapter_files_present"] is True
    assert comps["asr"]["model_scale_source"] == "training_manifest.model_scale"
    assert comps["roman"]["configured"] is False
