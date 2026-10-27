"""MOCKED contract fixtures for the VoxSOAP ml-serving test suite.

Every fake provider is explicitly marked is_mock=True and therefore reports
serving_mode="mocked-test-double" through the API envelope. The distinction
between mocked tests and real inference is asserted in these tests, never
implied: the real-inference tests live in test_real_inference.py and are
deselected by default (pytest -m "not real").
"""
from __future__ import annotations

import io
import struct
import sys
import wave
from pathlib import Path
from typing import List

import pytest
from fastapi.testclient import TestClient

SERVING_DIR = Path(__file__).resolve().parents[1]
if str(SERVING_DIR) not in sys.path:
    sys.path.insert(0, str(SERVING_DIR))

from config import ServingConfig  # noqa: E402
from providers import InferenceError  # noqa: E402


def pcm_wav_bytes(sample_rate: int = 16000, seconds: float = 0.3, freq_hz: int = 440) -> bytes:
    """Stdlib-built 16-bit mono PCM WAV (works without soundfile/numpy)."""
    n = int(sample_rate * seconds)
    half = max(1, sample_rate // (freq_hz * 2))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(sample_rate)
        frames = bytearray()
        for i in range(n):
            amp = 3000 if (i // half) % 2 == 0 else -3000
            frames += struct.pack("<h", amp)
        writer.writeframes(bytes(frames))
    return buf.getvalue()


class FakeMLProvider:
    """Test double for the ML provider - NEVER touches torch or weights."""

    name = "ml"
    is_mock = True

    def __init__(self, fail: bool = False):
        self.fail = fail
        self.calls: List[tuple] = []

    def scale_for(self, key: str):
        return "SMOKE(mock test-double; NOT real inference)", "test_double"

    def transcribe(self, samples, sample_rate: int, audio_bytes=None):
        self.calls.append(("transcribe", round(len(samples) / sample_rate, 3), sample_rate))
        if self.fail:
            raise InferenceError("fake ML inference failure (test double)")
        return {"text": "instrumented mock transcription 25 mg two times daily", "note": "MOCKED"}

    def draft(self, transcript: str):
        self.calls.append(("draft", len(transcript)))
        if self.fail:
            raise InferenceError("fake ML inference failure (test double)")
        return {
            "draft": (
                "SUBJECTIVE: cough for 3 days. OBJECTIVE: temperature 38.5. "
                "ASSESSMENT: start 25 mg syrup daily. PLAN: weight-based dose not stated."
            ),
            "note": "MOCKED",
        }

    def roman(self, text: str):
        self.calls.append(("roman", len(text)))
        if self.fail:
            raise InferenceError("fake ML inference failure (test double)")
        return {"roman": "roman-of(text) (MOCKED)"}

    def unload(self, key: str) -> bool:
        self.calls.append(("unload", key))
        return True

    def describe(self):
        return {
            key: {"mock": True, "model_scale": self.scale_for(key)[0], "loaded": False}
            for key in ("asr", "soap", "roman")
        }


class FakeGeminiProvider:
    """Test double for the Gemini proxy path - never touches the network."""

    name = "gemini"
    is_mock = True

    def scale_for(self, key: str):
        return "NOT_APPLICABLE(mock gemini test-double)", "test_double"

    def transcribe(self, samples, sample_rate: int, audio_bytes=None):
        return {"text": "fake-gemini-transcription", "upstream": "mocked"}

    def draft(self, transcript: str):
        return {"draft": "fake-gemini draft", "upstream": "mocked"}

    def roman(self, text: str):
        return {"roman": "fake-gemini roman", "upstream": "mocked"}

    def unload(self, key: str) -> bool:
        return False

    def describe(self):
        return {"mock": True}


@pytest.fixture()
def app():
    from app import create_app

    return create_app(ServingConfig())


@pytest.fixture()
def client(app):
    return TestClient(app)


@pytest.fixture()
def wav16k():
    return pcm_wav_bytes(sample_rate=16000)


@pytest.fixture()
def wav8k():
    return pcm_wav_bytes(sample_rate=8000)
