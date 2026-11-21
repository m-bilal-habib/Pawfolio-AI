"""Owner fix 2026-11-19: async draft jobs (202 + poll + cancel + single-flight).

MOCKED only: every provider here is an explicit test double with is_mock=True,
so the envelopes report serving_mode="mocked-test-double". No torch, no
llama_cpp, no weights, no network. The real-hardware drill lives outside this
suite (see ml-serving/reports/phase5_integration_plan.md §14).
"""
from __future__ import annotations

import threading
import time
from typing import Any, Dict, List, Optional

from conftest import FakeMLProvider
from providers import DraftCancelled


def _poll(
    client,
    job_id: str,
    until=("completed", "failed", "cancelled"),
    timeout: float = 5.0,
    min_tokens: Optional[int] = None,
) -> Dict[str, Any]:
    """Poll /draft/status until a terminal status (or a token threshold)."""
    deadline = time.time() + timeout
    last: Dict[str, Any] = {}
    while time.time() < deadline:
        r = client.get(f"/draft/status/{job_id}")
        assert r.status_code == 200, r.text
        last = r.json()
        if min_tokens is not None:
            if int(last.get("tokens_generated", 0)) >= min_tokens and last.get("status") == "generating":
                return last
        elif last.get("status") in until:
            return last
        time.sleep(0.02)
    raise AssertionError(f"job {job_id} did not reach {until or min_tokens}: {last}")


class CooperativeDraftProvider:
    """Deterministic per-token provider that honours cancel_event/progress_cb."""

    name = "ml"
    is_mock = True

    def __init__(self, total: int = 300, sleep_s: float = 0.01):
        self.total = total
        self.sleep_s = sleep_s
        self.cancelled = False
        self.completed = False

    def scale_for(self, key: str):
        return "SMOKE(contract test-double; NOT real inference)", "test_double"

    def draft(
        self,
        transcript: str,
        max_new_tokens=None,
        note_format: str = "vet_scribenote",
        cancel_event=None,
        progress_cb=None,
    ):
        tokens = int(max_new_tokens or self.total)
        for i in range(tokens):
            if cancel_event is not None and cancel_event.is_set():
                self.cancelled = True
                raise DraftCancelled("operator cancel (test double)")
            if progress_cb is not None:
                progress_cb(i + 1)
            time.sleep(self.sleep_s)
        self.completed = True
        return {
            "draft": "SUBJECTIVE: mock history. OBJECTIVE_MENTIONED: Weight: 24.5 kg "
            "ASSESSMENT: mock. PLAN: mock.",
            "max_new_tokens": tokens,
            "format": note_format,
            "sections": {
                "subjective": "mock history.",
                "objective_map": {"Weight": "24.5 kg"},
                "objective_text": "Weight: 24.5 kg",
                "assessment": "- mock.",
                "plan": "- mock.",
            },
            "note": "MOCKED",
        }

    def unload(self, key: str) -> bool:
        return True

    def describe(self):
        return {key: {"mock": True, "model_scale": self.scale_for(key)[0]} for key in ("asr", "soap", "roman")}


class BlockingDraftProvider(CooperativeDraftProvider):
    """Holds the job in-flight until the test releases it (deterministic 409)."""

    def __init__(self):
        super().__init__(total=1, sleep_s=0.0)
        self.release = threading.Event()
        self.entered = threading.Event()

    def draft(self, transcript, max_new_tokens=None, note_format="vet_scribenote", cancel_event=None, progress_cb=None):
        self.entered.set()
        assert self.release.wait(8.0), "test never released the blocking provider"
        return super().draft(
            transcript,
            max_new_tokens=max_new_tokens,
            note_format=note_format,
            cancel_event=cancel_event,
            progress_cb=progress_cb,
        )


def test_async_start_polls_to_completed_full_envelope(app, client):
    fake = FakeMLProvider()
    app.state.container.ml = fake
    r = client.post(
        "/draft/start",
        json={"transcript": "SUBJECTIVE: mock history. PLAN: mock plan."},
    )
    assert r.status_code == 202, r.text
    accepted = r.json()
    assert accepted["ok"] is True
    assert accepted["accepted"] is True
    assert accepted["job_id"]
    assert accepted["status"] in ("queued", "loading_model", "generating", "completed")
    assert accepted["format"] == "vet_scribenote"
    assert accepted["poll"] == f"GET /draft/status/{accepted['job_id']}"
    assert accepted["cancel"] == f"POST /draft/cancel/{accepted['job_id']}"
    assert accepted["serving_mode"] == "mocked-test-double"

    snap = _poll(client, accepted["job_id"])
    assert snap["status"] == "completed"
    assert snap["job_id"] == accepted["job_id"]
    assert snap["max_new_tokens"] == 256  # FakeMLProvider echoes its applied cap
    # FakeMLProvider has no progress_cb parameter -> the worker must not pass
    # one; the honest token count stays 0 (unknown), never a fabricated value.
    assert snap["tokens_generated"] == 0
    assert snap["elapsed_s"] >= 0

    result = snap["result"]
    assert result["ok"] is True
    assert result["service"] == "voxsoap-ml-serving"
    assert result["provider"] == "ml"
    assert result["serving_mode"] == "mocked-test-double"
    assert result["model_scale"].startswith("SMOKE")
    assert result["latency_s"] >= 0
    assert result["format"] == "vet_scribenote"
    assert set(result["sections"]) == {
        "subjective",
        "objective_map",
        "objective_text",
        "assessment",
        "plan",
    }
    # The completed job carries the SAME deterministic guard as sync /draft.
    assert set(result["guard"]) >= {"schema", "facts", "unstated_markers_used_in_draft", "review_hint"}
    assert result["guard"]["schema"]["complete_schema"] is True
    assert fake.calls and fake.calls[0][0] == "draft"

    # The job slot is released: a second start is accepted immediately.
    r2 = client.post("/draft/start", json={"transcript": "second draft"})
    assert r2.status_code == 202, r2.text
    _poll(client, r2.json()["job_id"])


def test_async_cancel_stops_worker_within_two_seconds(app, client):
    prov = CooperativeDraftProvider(total=300, sleep_s=0.01)
    app.state.container.ml = prov
    r = client.post(
        "/draft/start",
        json={"transcript": "cancel this draft please", "max_new_tokens": 300},
    )
    assert r.status_code == 202, r.text
    job_id = r.json()["job_id"]

    running = _poll(client, job_id, min_tokens=3, timeout=3.0)
    assert running["status"] == "generating"
    started_tokens = running["tokens_generated"]
    assert started_tokens >= 3

    cancel = client.post(f"/draft/cancel/{job_id}")
    assert cancel.status_code == 200, cancel.text
    cancel_body = cancel.json()
    assert cancel_body["cancel_requested"] is True
    assert "cancel requested" in cancel_body["note"]

    final = _poll(client, job_id, until=("cancelled",), timeout=2.0)
    assert final["status"] == "cancelled"
    assert final["cancel_requested"] is True
    assert "result" not in final
    assert "error" not in final
    assert prov.cancelled is True
    assert prov.completed is False
    # The loop stopped near the cancel point, not at the 300-token cap.
    assert final["tokens_generated"] < 300


def test_concurrent_start_returns_honest_409_then_slot_recovers(app, client):
    prov = BlockingDraftProvider()
    app.state.container.ml = prov
    first = client.post("/draft/start", json={"transcript": "first draft"})
    assert first.status_code == 202, first.text
    first_job = first.json()["job_id"]
    assert prov.entered.wait(2.0), "worker never entered draft()"

    second = client.post("/draft/start", json={"transcript": "second draft"})
    assert second.status_code == 409, second.text
    busy = second.json()
    assert busy["ok"] is False
    assert busy["error"] == "draft_busy"
    assert busy["detail"]["active_job_id"] == first_job
    assert busy["detail"]["active_status"] in ("queued", "loading_model", "generating")

    # The synchronous route shares the SAME single-flight lock.
    sync = client.post("/draft", json={"transcript": "sync draft"})
    assert sync.status_code == 409, sync.text
    assert sync.json()["error"] == "draft_busy"

    prov.release.set()
    done = _poll(client, first_job)
    assert done["status"] == "completed"

    third = client.post("/draft/start", json={"transcript": "third draft"})
    assert third.status_code == 202, third.text
    done3 = _poll(client, third.json()["job_id"])
    assert done3["status"] == "completed"


def test_unknown_job_ids_are_honest_400(app, client):
    app.state.container.ml = FakeMLProvider()
    r = client.get("/draft/status/doesnotexist")
    assert r.status_code == 400, r.text
    body = r.json()
    assert body["error"] == "bad_request"
    assert "unknown draft job_id" in body["message"]

    c = client.post("/draft/cancel/doesnotexist")
    assert c.status_code == 400, c.text
    assert c.json()["error"] == "bad_request"


def test_start_validation_gates_run_before_queuing(app, client):
    app.state.container.ml = FakeMLProvider()
    for payload, needle in (
        ({"transcript": ""}, "transcript is empty"),
        ({"transcript": "x", "max_new_tokens": 0}, "max_new_tokens must be between"),
        ({"transcript": "x", "format": "klingon"}, "unsupported draft format"),
    ):
        r = client.post("/draft/start", json=payload)
        assert r.status_code == 400, r.text
        assert needle in r.json()["message"]
    # Nothing was queued by the rejected requests.
    ok = client.post("/draft/start", json={"transcript": "valid transcript"})
    assert ok.status_code == 202, ok.text
    _poll(client, ok.json()["job_id"])
