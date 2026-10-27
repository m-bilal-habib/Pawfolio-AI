"""POST /transcribe contract - mocked provider doubles (NOT real inference)."""
from __future__ import annotations

from conftest import FakeMLProvider


def test_transcribe_happy(app, client, wav16k):
    fake = FakeMLProvider()
    app.state.container.ml = fake
    r = client.post("/transcribe", files={"audio": ("clip.wav", wav16k, "audio/wav")})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["provider"] == "ml"
    assert body["serving_mode"] == "mocked-test-double"
    assert body["model_scale"].startswith("SMOKE(mock")
    assert body["text"].startswith("instrumented mock")
    assert body["audio"]["sample_rate"] == 16000
    assert body["audio"]["decoded_samples"] > 0
    assert fake.calls and fake.calls[0][0] == "transcribe" and fake.calls[0][2] == 16000


def test_transcribe_honest_400_on_wrong_sample_rate(app, client, wav8k):
    app.state.container.ml = FakeMLProvider()
    r = client.post("/transcribe", files={"audio": ("clip.wav", wav8k, "audio/wav")})
    assert r.status_code == 400
    body = r.json()
    assert body["ok"] is False
    assert "16000" in body["message"]          # honest, explicit refusal
    assert "resamp" in body["message"]         # states the no-silent-resample rule
    assert "model_scale" in body               # scale label present even on errors
    assert body["provider"] == "ml"


def test_transcribe_requires_audio_field(client):
    r = client.post("/transcribe")
    assert r.status_code == 422
    assert r.json()["ok"] is False
