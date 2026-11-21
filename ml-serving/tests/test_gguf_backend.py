"""Owner fix 2026-11-19: quantized GGUF CPU draft backend (MOCKED).

`llama_cpp` is replaced by an in-process fake module: no native library, no
weights, no downloads. These tests pin the ROUTING rules (vet_scribenote on
CPU -> GGUF; medscribe/CUDA/explicit torch -> torch), the SAME prompt +
deterministic hydration pipeline, honest envelope provenance (a quantized base
GGUF is never labelled as the unquantized PEFT adapter), per-token progress /
cancellation, and unload hygiene.

The real-hardware numbers (tok/s, cold load, RSS) are recorded in
ml-serving/reports/phase5_integration_plan.md §14 - never inferred here.
"""
from __future__ import annotations

import sys
import threading
import types
from pathlib import Path

import pytest

from config import ServingConfig
from providers import (
    DraftCancelled,
    InferenceError,
    MLProvider,
    VET_OBJECTIVE_PARAMS,
    VET_SCRIBENOTE_SYSTEM_PROMPT,
)

GGUF_FILE = "qwen2.5-3b-instruct-q4_k_m.gguf"

# Same base-Qwen output shape the live vet prompt produces (fixture from
# test_vet_scribenote_contract.py); the deterministic hydration fills the
# other 21 objective params with "Not mentioned".
LEO_MODEL_OUTPUT = """SUBJECTIVE:
Leo is a 3.5-year-old male canine presenting with a 3-day history of head shaking, scratching at the right ear, whimpering episodes, and a noticeable odor from the right ear. The owner bathed him at the groomer about one week ago. He has a past history of skin allergies in the summer, previously treated with Apoquel.

OBJECTIVE_MENTIONED:
Weight: 24.5 kg
Ears: The right ear canal is very red and inflamed with a foul odor and some debris.

ASSESSMENT:
- Acute otitis externa of the right ear, secondary to moisture retention after the recent bath.
- Patient is due for vaccinations.

PLAN:
- Administer DHPP and Rabies vaccines today.
- Continue with daily ear cleaner at home.
- Posatex: 4 drops into the right ear once daily for 7 days.
- Recheck in 10 days.
"""

TRANSCRIPT = (
    "So Leo has been shaking his head for three days. He weighs 24.5 kg. "
    "The right ear canal is very red and inflamed with a foul odor and some debris. "
    "The owner bathed him at the groomer about one week ago and he has summer skin "
    "allergies, previously treated with Apoquel. He is due for vaccinations, so give "
    "DHPP and Rabies today, continue daily ear cleaner at home, Posatex 4 drops into "
    "the right ear once daily for 7 days, and recheck in 10 days."
)


class _FakeStream:
    def __init__(self, chunks):
        self._chunks = chunks
        self.closed = False

    def __iter__(self):
        return iter(self._chunks)

    def close(self):
        self.closed = True


class _FakeLlama:
    init_kwargs = {}
    last_call = {}

    def __init__(self, **kwargs):
        type(self).init_kwargs = kwargs

    def create_chat_completion(self, **kwargs):
        type(self).last_call = kwargs
        text = LEO_MODEL_OUTPUT
        step = 40
        pieces = [text[i : i + step] for i in range(0, len(text), step)]
        chunks = [{"choices": [{"delta": {"content": piece}}]} for piece in pieces]
        chunks.append({"choices": [{"delta": {}}]})  # terminal usage-ish chunk
        return _FakeStream(chunks)


def _fake_llama_module(monkeypatch):
    fake_module = types.ModuleType("llama_cpp")
    fake_module.Llama = _FakeLlama
    monkeypatch.setitem(sys.modules, "llama_cpp", fake_module)
    return fake_module


def _gguf_provider(monkeypatch, **overrides):
    cfg = ServingConfig(
        soap_backend=overrides.pop("soap_backend", "gguf"),
        soap_gguf_repo="Qwen/Qwen2.5-3B-Instruct-GGUF",
        soap_gguf_file=GGUF_FILE,
        soap_n_ctx=overrides.pop("soap_n_ctx", 4096),
        soap_n_threads=overrides.pop("soap_n_threads", 2),
        **overrides,
    )
    provider = MLProvider(cfg)
    monkeypatch.setattr(provider, "_resolve_device", lambda: "cpu")
    monkeypatch.setattr(provider, "_release_asr_before_draft", lambda: False)
    monkeypatch.setattr(
        provider,
        "_resolve_gguf_model_path",
        lambda: Path("C:/fake-models") / GGUF_FILE,
    )
    return provider


def test_backend_routing_matrix(monkeypatch):
    monkeypatch.setattr(MLProvider, "_gguf_available", staticmethod(lambda: True))
    auto = MLProvider(ServingConfig())
    assert auto._soap_backend_for("vet_scribenote", "cpu") == "gguf"
    assert auto._soap_backend_for("vet_scribenote", "cuda") == "torch"
    # The legacy PEFT adapter contract stays on torch, ALWAYS.
    assert auto._soap_backend_for("medscribe", "cpu") == "torch"
    assert auto._soap_backend_for("medscribe", "cuda") == "torch"

    explicit_torch = MLProvider(ServingConfig(soap_backend="torch"))
    assert explicit_torch._soap_backend_for("vet_scribenote", "cpu") == "torch"

    monkeypatch.setattr(MLProvider, "_gguf_available", staticmethod(lambda: False))
    # auto degrades honestly to the existing torch path, never a silent GGUF claim.
    assert auto._soap_backend_for("vet_scribenote", "cpu") == "torch"


def test_explicit_gguf_without_llama_cpp_is_honest_503(monkeypatch):
    monkeypatch.setattr(MLProvider, "_gguf_available", staticmethod(lambda: False))
    provider = MLProvider(ServingConfig(soap_backend="gguf"))
    with pytest.raises(InferenceError) as err:
        provider._soap_backend_for("vet_scribenote", "cpu")
    assert "llama-cpp-python is not installed" in err.value.message
    assert err.value.status_code == 503


def test_gguf_draft_uses_same_prompt_pipeline_progress_and_metadata(monkeypatch):
    _fake_llama_module(monkeypatch)
    provider = _gguf_provider(monkeypatch)

    progress = []
    payload = provider.draft(
        TRANSCRIPT,
        max_new_tokens=96,
        note_format="vet_scribenote",
        progress_cb=lambda n: progress.append(n),
    )

    assert payload["backend"] == "gguf"
    assert payload["gguf_model"] == GGUF_FILE
    assert payload["format"] == "vet_scribenote"
    assert payload["generation"] == "greedy"
    assert payload["max_new_tokens"] == 96
    assert "LoRA adapter NOT applied" in payload["model_scale"]
    assert payload["model_scale"].startswith("FULL-BASE-GGUF(")

    sections = payload["sections"]
    assert set(sections) == {"subjective", "objective_map", "objective_text", "assessment", "plan"}
    objective = sections["objective_map"]
    assert list(objective.keys()) == list(VET_OBJECTIVE_PARAMS)
    assert objective["Weight"] == "24.5 kg"
    assert "red and inflamed" in objective["Ears"]
    mentioned = {name for name, value in objective.items() if value != "Not mentioned"}
    assert mentioned == {"Weight", "Ears"}

    # Same system prompt, same chat shape, greedy decode, cap honoured.
    call = _FakeLlama.last_call
    assert call["messages"][0] == {"role": "system", "content": VET_SCRIBENOTE_SYSTEM_PROMPT}
    assert call["messages"][1] == {"role": "user", "content": TRANSCRIPT}
    assert call["temperature"] == 0.0
    assert call["max_tokens"] == 96
    assert call["stream"] is True

    init = _FakeLlama.init_kwargs
    assert init["n_ctx"] == 4096
    assert init["n_threads"] == 2
    assert init["n_gpu_layers"] == 0
    assert init["model_path"].endswith(GGUF_FILE)

    # One progress tick per streamed content chunk (real token counter).
    assert progress and progress == sorted(progress)
    assert progress[-1] == len(LEO_MODEL_OUTPUT) // 40 + (1 if len(LEO_MODEL_OUTPUT) % 40 else 0)


def test_gguf_pre_set_cancel_event_stops_before_any_token(monkeypatch):
    _fake_llama_module(monkeypatch)
    provider = _gguf_provider(monkeypatch)
    event = threading.Event()
    event.set()
    progress = []
    with pytest.raises(DraftCancelled):
        provider.draft(
            TRANSCRIPT,
            max_new_tokens=32,
            note_format="vet_scribenote",
            cancel_event=event,
            progress_cb=lambda n: progress.append(n),
        )
    assert progress == []


def test_gguf_state_nests_in_soap_slot_and_unload_drops_it(monkeypatch):
    _fake_llama_module(monkeypatch)
    provider = _gguf_provider(monkeypatch)
    provider.draft(TRANSCRIPT, max_new_tokens=16, note_format="vet_scribenote")

    state = provider._loaded["soap"]
    assert state is not None and state["backend"] == "gguf"
    assert set(provider._loaded) == {"asr", "soap", "roman"}
    summary = provider.soap_backend_summary()
    assert summary["effective"] == "gguf"
    assert summary["loaded"] is True
    assert summary["gguf_file"] == GGUF_FILE

    assert provider.unload("soap") is True
    assert provider._loaded["soap"] is None
    assert provider.describe()["soap"]["loaded"] is False
    assert provider.soap_backend_summary()["loaded"] is False


def test_api_draft_envelope_reports_gguf_provenance(app, client, monkeypatch):
    _fake_llama_module(monkeypatch)
    provider = _gguf_provider(monkeypatch)
    app.state.container.ml = provider

    r = client.post(
        "/draft",
        json={"transcript": TRANSCRIPT, "max_new_tokens": 96, "format": "vet_scribenote"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["provider"] == "ml"
    assert body["backend"] == "gguf"
    assert body["gguf_model"] == GGUF_FILE
    assert body["model_scale"].startswith("FULL-BASE-GGUF(")
    assert body["format"] == "vet_scribenote"
    assert set(body["sections"]) == {
        "subjective",
        "objective_map",
        "objective_text",
        "assessment",
        "plan",
    }
    assert body["sections"]["objective_map"]["Weight"] == "24.5 kg"
    assert len(body["sections"]["objective_map"]) == 23
    # Deterministic guard rides the SAME envelope as the torch path.
    assert set(body["guard"]) >= {"schema", "facts", "unstated_markers_used_in_draft", "review_hint"}
    assert body["guard"]["schema"]["complete_schema"] is True


def test_resolve_gguf_auto_discovers_local_models_dir(tmp_path, monkeypatch):
    import providers as providers_mod

    models_dir = tmp_path / "models"
    models_dir.mkdir()
    fake_blob = models_dir / GGUF_FILE
    fake_blob.write_bytes(b"GGUF")
    # Redirect providers.__file__ so Path(__file__).resolve().parent / "models" hits tmp_path/models
    monkeypatch.setattr(providers_mod, "__file__", str(tmp_path / "providers.py"))
    provider = MLProvider(ServingConfig(soap_gguf_file=GGUF_FILE, soap_gguf_path=None))
    assert provider._resolve_gguf_model_path() == fake_blob
