"""POST /unload contract - lazy-load/unload Windows RAM safeguard (mocked + real-provider states)"""
from __future__ import annotations

from conftest import FakeMLProvider


def test_unload_all(app, client):
    app.state.container.ml = FakeMLProvider()
    r = client.post("/unload", json={"component": "all"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["unload_status"] == {"asr": True, "soap": True, "roman": True}
    assert set(body["model_scale_after"]) == {"asr", "soap", "roman"}
    assert "swap" in body["note"].lower()


def test_unload_single_component(app, client):
    app.state.container.ml = FakeMLProvider()
    r = client.post("/unload", json={"component": "asr"})
    assert r.status_code == 200
    assert r.json()["unload_status"] == {"asr": True}


def test_unload_unknown_component(app, client):
    r = client.post("/unload", json={"component": "whisper"})
    assert r.status_code == 400
    assert r.json()["error"] == "bad_request"


def test_unload_on_real_provider_reports_false_when_nothing_loaded(client):
    # Real MLProvider: /health-style state, nothing loaded in a fresh process.
    r = client.post("/unload")
    assert r.status_code == 200
    assert r.json()["unload_status"] == {"asr": False, "soap": False, "roman": False}
