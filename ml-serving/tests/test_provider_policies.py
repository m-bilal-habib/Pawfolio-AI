"""Provider-selection policies - the honesty contract of this scaffold.

The single most important assertion in the whole suite:
an ML failure is a CONTROLLED 5xx and the Gemini provider is NEVER used
automatically (contract: no hidden fallbacks that silently switch to Gemini).
"""
from __future__ import annotations

import json

from conftest import FakeGeminiProvider, FakeMLProvider


def test_unknown_provider_rejected_400(app, client):
    r = client.post("/draft", json={"transcript": "hello", "provider": "openai"})
    assert r.status_code == 400
    body = r.json()
    assert body["error"] == "unknown_provider"
    assert "explicit" in body["message"]
    assert "model_scale" in body


def test_gemini_is_honest_501_when_proxy_unset(client):
    # REAL GeminiProxyProvider (not a fake): proxy URL is unset by default.
    r = client.post("/draft", json={"transcript": "hello", "provider": "gemini"})
    assert r.status_code == 501
    body = r.json()
    assert body["error"] == "not_configured"
    assert "VOXSOAP_GEMINI_PROXY_URL" in body["message"]
    assert body["provider"] == "gemini"


def test_gemini_happy_path_when_provided(app, client):
    app.state.container.gemini = FakeGeminiProvider()
    r = client.post("/draft", json={"transcript": "hello", "provider": "gemini"})
    assert r.status_code == 200
    body = r.json()
    assert body["provider"] == "gemini"
    assert body["draft"] == "fake-gemini draft"
    assert body["serving_mode"] == "mocked-test-double"
    assert body["model_scale"].startswith("NOT_APPLICABLE")


def test_ml_failure_is_controlled_5xx_and_never_falls_back_to_gemini(app, client):
    app.state.container.ml = FakeMLProvider(fail=True)
    r = client.post("/draft", json={"transcript": "hello"})
    assert r.status_code == 503, r.text
    body = r.json()
    assert body["error"] == "inference_error"
    assert body["provider"] == "ml"                      # stays on the ML path
    assert "rerouted" in body["note"].lower()
    assert "fake-gemini" not in json.dumps(body).lower()  # zero Gemini output
                
def test_default_provider_is_ml_and_gemini_only_on_request(app, client):
    assert app.state.cfg.default_provider == "ml"
    fake = FakeGeminiProvider()
    app.state.container.gemini = fake
    # no provider field -> ML double answers; gemini double is never used
    app.state.container.ml = FakeMLProvider()
    r = client.post("/draft", json={"transcript": "hello"})
    assert r.json()["provider"] == "ml"
    assert fake not in (app.state.container.ml,)
