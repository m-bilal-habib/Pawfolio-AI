"""POST /transcribe contract - mocked provider doubles (NOT real inference).

Two layers of the SAME route contract live here:
  1. the envelope contract (audio echo, honest 400 on wrong sample rate,
     422 requiring the audio field) - the committed Phase-4 layer;
  2. the language + windowing contract (ur/en/auto forwarding, honest 400
     for unsupported languages, default "ur" preserved) - the Phase-5
     2026-10-31 E2E-fix layer, probed with an in-process recording double.
"""
from __future__ import annotations

import pytest

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


# ---------------------------------------------------------------------------
# Phase-5 language contract (2026-10-31): the in-process probe double records
# exactly what reached the provider layer; torch is never touched.
# ---------------------------------------------------------------------------

_API_LANGUAGES = ("ur", "en", "auto")


class _ProbeAsrProvider:
    """Minimal controlled recording double for /transcribe (no torch)."""

    name = "ml"
    is_mock = False  # intentionally real-looking: probes the real envelope path

    def __init__(self):
        self.records = []

    def scale_for(self, key: str):
        return "SMOKE(probe test-double; NOT real inference)", "test_double"

    def transcribe(self, samples, sample_rate: int, audio_bytes=None, language: str = "ur"):
        self.records.append(
            {
                "seconds": len(samples) / float(sample_rate),
                "sample_rate": sample_rate,
                "language": language,
            }
        )
        return {
            "text": "instrumented probe transcription 25 mg two times daily",
            "language": language,
            "sample_rate": sample_rate,
            "windows": 1,
            "note": "PROBED (mocked contract test)",
        }

    def draft(self, transcript: str, max_new_tokens=None, note_format: str = "vet_scribenote"):
        raise NotImplementedError("draft is not under test here")

    def roman(self, text: str):
        raise NotImplementedError("roman is not under test here")

    def unload(self, key: str) -> bool:
        return False

    def describe(self):
        return {
            key: {"probe": True, "model_scale": self.scale_for(key)[0], "loaded": False}
            for key in ("asr", "soap", "roman")
        }


@pytest.fixture()
def probe_asr(app):
    provider = _ProbeAsrProvider()
    app.state.container.ml = provider
    return provider


@pytest.mark.parametrize("requested,expected", [("en", "en"), ("auto", "auto")])
def test_transcribe_language_is_forwarded(client, probe_asr, wav16k, requested, expected):
    r = client.post(
        "/transcribe",
        files={"audio": ("probe.wav", wav16k, "audio/wav")},
        data={"language": requested},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert probe_asr.records[-1]["language"] == expected
    assert body["language"] == expected
    assert body["serving_mode"] == "real-provider"
    assert body["windows"] == 1


def test_transcribe_defaults_to_ur(client, probe_asr, wav16k):
    r = client.post("/transcribe", files={"audio": ("probe.wav", wav16k, "audio/wav")})
    assert r.status_code == 200, r.text
    assert probe_asr.records[-1]["language"] == "ur"
    assert r.json()["language"] == "ur"


def test_transcribe_rejects_unknown_language_honestly(client, probe_asr, wav16k):
    r = client.post(
        "/transcribe",
        files={"audio": ("probe.wav", wav16k, "audio/wav")},
        data={"language": "klingon"},
    )
    assert r.status_code == 400
    body = r.json()
    assert body["error"] == "bad_request"
    assert "ur | en | auto" in body["message"]
    # nothing reached the provider: the request was rejected at the API layer
    assert probe_asr.records == []


@pytest.mark.parametrize("lang", _API_LANGUAGES)
def test_language_contract_is_the_documented_set(client, probe_asr, wav16k, lang):
    r = client.post(
        "/transcribe",
        files={"audio": ("probe.wav", wav16k, "audio/wav")},
        data={"language": lang},
    )
    assert r.status_code == 200, r.text
    assert probe_asr.records[-1]["language"] == lang
