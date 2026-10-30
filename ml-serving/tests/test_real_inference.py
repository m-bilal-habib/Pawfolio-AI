"""REAL model inference gate - clearly separated from the mocked suite.

These tests exercise the ACTUAL full-scale Phase-3 adapters (run
20261030-165202) with real torch/transformers. They are gated by the `real`
marker and skipped (with an honest reason) when torch is not importable, e.g.
the current 32-bit Python 3.15 environment on this machine, which has no torch
win32 wheels.

First Colab gate (2026-10-30, T4): 3/3 PASSED (health / transcribe / roman-501)
and it also CAUGHT the unresolved-version drift that crashed real /draft
(KeyError: 'shape' from a BatchEncoding returned by apply_chat_template);
that call site now unwraps BOTH shapes and the runtime is pinned in
requirements-serving-ml.txt. The 4th test actually drives real /draft.

Run them where the pin-file stack exists:  py -m pytest ml-serving/tests -m real
Mocked contract suite:                     py -m pytest ml-serving/tests -m "not real"
"""
from __future__ import annotations

import importlib.util
import os

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


def _draft_real_ready():
    """Real /draft loads the 3B SOAP base (plain fp16 on CUDA, fp32 on CPU).

    Honest availability gate: run where CUDA exists (e.g. the Colab gate), or
    force-opt-in with VOXSOAP_REAL_DRAFT_FORCE=1 if local CPU RAM is measured
    sufficient (~12-13 GB free for the fp32 3B load). Never silently half-tests.
    """
    spec = importlib.util.find_spec("torch")
    if spec is None:
        return False
    try:
        import torch

        return bool(torch.cuda.is_available()) or os.getenv("VOXSOAP_REAL_DRAFT_FORCE") == "1"
    except Exception:
        return False


_draft_env_not_ready = not _draft_real_ready()


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


_draft_skip_reason = (
    "REAL /draft loads the full 3B SOAP base: fp16 on CUDA (~6 GB VRAM) or fp32 on CPU "
    "(~12-13 GB RAM - do not force it casually on a 16 GB Windows machine). Run on CUDA "
    "(e.g. the Colab gate) or set VOXSOAP_REAL_DRAFT_FORCE=1 with ~13 GB free RAM. "
    "NOT a test failure; an honest skip."
)


@pytest.mark.skipif(_draft_env_not_ready, reason=_draft_skip_reason)
def test_real_draft_with_fullscale_adapter(app, client):
    r = client.post(
        "/draft",
        json={
            "transcript": (
                "Salam doctor, my dog Baxter has been vomiting since yesterday. "
                "Temperature 38.5. He weighs 25 kg. Start 25 mg syrup daily."
            )
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["provider"] == "ml"
    assert body["serving_mode"] == "real-provider"
    assert body["model_scale"].startswith("FULL")
    draft_text = body["draft"]
    assert isinstance(draft_text, str) and len(draft_text) >= 40
    # SOAP-section presence is deliberately NOT hard-asserted here: automated
    # signals are not a clinical verdict - section completeness is scored in
    # Stage-13-style evaluation and the vet review sheet is the deciding artifact.
    assert body["note"]
