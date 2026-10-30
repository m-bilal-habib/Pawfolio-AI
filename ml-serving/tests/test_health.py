"""/health contract - mocked run (no model loading, no torch)."""
from __future__ import annotations

from pathlib import Path

_WORKSPACE = Path(__file__).resolve().parents[2]
_FULLSCALE_ASR_MANIFEST = (
    _WORKSPACE / "ml-training" / "artifacts" /
    "unpacked_voxsoap_ml_exports_20261030-165202" / "asr" /
    "whisper-lora-ur-20261030-165202" / "training_manifest.json"
)


def _require_fullscale_artifacts():
    assert _FULLSCALE_ASR_MANIFEST.is_file(), (
        "full-scale Phase-3 export missing/unpacked incorrectly - expected "
        f"{_FULLSCALE_ASR_MANIFEST} (see ml-training/reports/phase3_gate_report.md)"
    )


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
    _require_fullscale_artifacts()
    r = client.get("/health")
    body = r.json()
    scale = body["model_scale"]
    assert set(scale) == {"asr", "soap", "roman"}
    # Full-scale artifacts carry the tag directly in their training manifests.
    assert scale["asr"] == "FULL"
    assert scale["soap"] == "FULL"
    # Model C (roman) is DEPRECATED: adapter_dir defaults to None -> an honest
    # UNKNOWN label; /roman answers 501 (see test_scale_labels.py for the
    # derivation rules themselves).
    assert scale["roman"].startswith("UNKNOWN")


def test_health_policy_block(client):
    r = client.get("/health")
    body = r.json()
    assert body["policy"]["silent_gemini_fallback"] == "never - ML failure returns a controlled 5xx"
    assert "lazy" in body["policy"]["model_loading"]
    assert "unload" in body["policy"]["unload_helper"]


def test_health_reports_fullscale_adapter_files(client):
    _require_fullscale_artifacts()
    r = client.get("/health")
    comps = r.json()["providers"]["ml"]["components"]
    assert comps["asr"]["adapter_files_present"] is True
    assert comps["soap"]["adapter_files_present"] is True
    assert comps["asr"]["model_scale_source"] == "training_manifest.model_scale"
    assert comps["roman"]["configured"] is False
