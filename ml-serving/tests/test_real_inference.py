"""REAL model inference gate - clearly separated from the mocked suite.

These tests exercise the actual Phase-2 adapters + real torch/transformers.
They are gated by the `real` marker and skipped (with an honest reason) when
torch is not importable, e.g. the current 32-bit Python 3.15 environment on
this machine, which has no torch win32 wheels.

Run them where torch exists:  py -m pytest ml-serving/tests -m real
Mocked contract suite:        py -m pytest ml-serving/tests -m "not real"
"""
from __future__ import annotations

import importlib.util

import pytest

_torch_spec = importlib.util.find_spec("torch")

pytestmark = [
    pytest.mark.real,
    pytest.mark.skipif(
        _torch_spec is None,
        reason=(
            "REAL INFERENCE GATE: torch is not importable in this Python environment. "
            "This machine only has 32-bit Python 3.15 (no torch win32 wheels exist) - "
            "run these tests on a 64-bit interpreter or Colab. NOT a test failure; an honest skip."
        ),
    ),
]


def test_real_health_reports_unloaded_real_components(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["providers"]["ml"]["is_mock"] is False
    assert body["providers"]["ml"]["components"]["asr"]["adapter_files_present"] is True


def test_real_transcribe_with_phase2_adapter(app, client, wav16k):
    r = client.post("/transcribe", files={"audio": ("clip.wav", wav16k, "audio/wav")})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["serving_mode"] == "real-provider"
    assert body["provider"] == "ml"
    assert isinstance(body["text"], str)
    assert body["model_scale"].startswith(("FULL", "SMOKE(assumed"))


def test_real_roman_stays_501_until_model_c_lands(client):
    r = client.post("/roman", json={"text": "salam"})
    assert r.status_code == 501
    assert "VOXSOAP_ROMAN_ADAPTER_DIR" in r.json()["message"]
