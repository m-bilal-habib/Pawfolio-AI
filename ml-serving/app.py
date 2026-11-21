"""VoxSOAP ML serving - FastAPI app (Phase 4 scaffold, development only).

Contract: a Python FastAPI process runs on the user's Windows machine, loads
the trained artifacts from local directories, and the Next.js server calls it
over http://127.0.0.1:<port>.

Honesty contract enforced in this file:
 * Starting the process loads NO model (lazy/on-demand loading - Windows RAM
   safeguard) and claims NO production readiness.
 * EVERY response (success or controlled error) carries a model_scale label
   with an explicit source, or an explicit UNAVAILABLE/NOT_APPLICABLE label.
 * provider is explicit per request (ml | gemini). An ML failure returns a
   controlled 5xx; there is NEVER a silent Gemini fallback.
 * /roman answers an honest 501 - Model C is DEPRECATED (2026-10-29; runs
 * 9/10/11 failed quality), so 501 stands unless the owner re-enables with a
 * passing adapter.
"""
from __future__ import annotations

import asyncio
import inspect
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, Optional, Tuple

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import audio_utils
from audio_utils import AudioDecodeError
from config import ServingConfig, load_config
from guards import clinical_guard
from providers import VET_NOTE_FORMATS
from providers import (
    BadRequest,
    DraftBusy,
    DraftCancelled,
    GeminiProxyProvider,
    InferenceError,
    MLProvider,
    ProviderError,
    UnknownProvider,
)

API_TITLE = "VoxSOAP ML serving (Phase 4 scaffold - development only)"


class ServiceContainer:
    def __init__(self, cfg: ServingConfig):
        self.cfg = cfg
        self.ml = MLProvider(cfg)
        self.gemini = GeminiProxyProvider(cfg)

    def resolve(self, requested: Optional[str]):
        name = (requested or self.cfg.default_provider or "").strip().lower()
        if name == "ml":
            return self.ml
        if name == "gemini":
            return self.gemini
        raise UnknownProvider(
            f"provider {name!r} is not recognized; allowed values: ml, gemini "
            "(an explicit choice is required - there is no hidden automatic switching)"
        )


# ---- shared envelope builders (2026-11-19 async job reuse) ------------------

def serving_mode_of(provider_obj: Any) -> str:
    return "mocked-test-double" if getattr(provider_obj, "is_mock", False) else "real-provider"


def scale_label_for(provider_obj: Any, component: Optional[str]) -> str:
    try:
        return provider_obj.scale_for(component)[0]
    except ProviderError as err:
        return f"UNAVAILABLE: {str(err.message)[:160]}"
    except Exception as err:  # defensive - even introspection must not 500
        return f"UNAVAILABLE ({type(err).__name__}: {err})"


def success_body(
    provider_obj: Any, component: Optional[str], payload: Dict[str, Any], started: float
) -> Dict[str, Any]:
    body: Dict[str, Any] = {
        "ok": True,
        "service": "voxsoap-ml-serving",
        "phase": "4-scaffold",
        "provider": provider_obj.name,
        "serving_mode": serving_mode_of(provider_obj),
        "model_scale": scale_label_for(provider_obj, component),
        "latency_s": round(time.perf_counter() - started, 4),
    }
    body.update(payload)
    return body


def error_body(
    provider_obj: Any, component: Optional[str], exc: ProviderError
) -> Dict[str, Any]:
    return {
        "ok": False,
        "error": exc.code,
        "message": exc.message,
        "detail": exc.detail,
        "provider": provider_obj.name if provider_obj else None,
        "serving_mode": serving_mode_of(provider_obj) if provider_obj else None,
        "model_scale": (
            scale_label_for(provider_obj, component)
            if provider_obj
            else "UNAVAILABLE(no provider resolved)"
        ),
        "note": "controlled error - the request was NOT silently rerouted to another provider",
    }


class DraftJobManager:
    """In-memory single-flight async draft jobs (owner fix 2026-11-19).

    Why: the 20-minute silent POST is exactly what the proxy budget keeps
    killing on a slow CPU box, and a 504'd request used to leave the Python
    decode loop burning CPU forever (no cancellation hook). Jobs make the
    submit instant (202), progress observable (tokens/status), cancellation
    one token deep, and CONCURRENT drafts impossible (one 2-core box must
    never stack two 3B decodes - that is how the paging death spiral starts).

    Honesty is untouched: the completed job's `result` is the SAME /draft
    envelope (draft, sections, guard, provider, serving_mode, model_scale,
    latency_s, note); a failed job carries the SAME controlled error envelope.
    Jobs live in this process only (a restart clears them - documented).
    """

    _ACTIVE_STATUSES = ("queued", "loading_model", "generating")

    def __init__(self, cfg: ServingConfig):
        self._cfg = cfg
        self._lock = threading.Lock()
        self._jobs: Dict[str, Dict[str, Any]] = {}
        self._active_id: Optional[str] = None
        self._executor = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="voxsoap-draft-worker"
        )

    # -- public API ----------------------------------------------------------

    def start(
        self,
        *,
        provider_obj: Any,
        transcript: str,
        fmt: str,
        max_new_tokens: Optional[int],
    ) -> Dict[str, Any]:
        job_id = uuid.uuid4().hex
        with self._lock:
            if self._active_id is not None:
                active = self._jobs.get(self._active_id) or {}
                raise DraftBusy(
                    "a draft is already in flight in this process (single-flight guard - "
                    "two concurrent 3B decodes would page-thrash this box); wait for it, "
                    "poll GET /draft/status/<job_id>, or cancel it via POST /draft/cancel/<job_id>.",
                    detail={
                        "active_job_id": self._active_id,
                        "active_status": active.get("status", "sync"),
                    },
                )
            job = {
                "id": job_id,
                "status": "queued",
                "stage_hint": "queued",
                "provider_obj": provider_obj,
                # cached once: scale_for() reads the adapter manifest from disk,
                # and a <10 ms status poll must never touch the filesystem.
                "model_scale": scale_label_for(provider_obj, "soap"),
                "transcript": transcript,
                "format": fmt,
                "max_new_tokens_request": max_new_tokens,
                "max_new_tokens": int(
                    max_new_tokens
                    if max_new_tokens is not None
                    else self._cfg.draft_max_new_tokens
                ),
                "tokens_generated": 0,
                "created_perf": time.perf_counter(),
                "created_at": time.time(),
                "finished_perf": None,
                "cancel_event": threading.Event(),
                "result": None,
                "error": None,
            }
            self._jobs[job_id] = job
            self._active_id = job_id
        job["future"] = self._executor.submit(self._run, job)
        return self.snapshot(job_id)

    def snapshot(self, job_id: str) -> Dict[str, Any]:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                raise BadRequest(
                    f"unknown draft job_id {job_id!r} - jobs live in this serving process "
                    "only (a restart clears them; submit a new POST /draft/start)."
                )
            return self._snapshot_locked(job)

    def cancel(self, job_id: str) -> Dict[str, Any]:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                raise BadRequest(
                    f"unknown draft job_id {job_id!r} - jobs live in this serving process "
                    "only (a restart clears them; submit a new POST /draft/start)."
                )
            job["cancel_event"].set()
            snap = self._snapshot_locked(job)
            if job["status"] in ("completed", "failed", "cancelled"):
                snap["note"] = f"job is already {job['status']} - nothing left to cancel"
            else:
                snap["note"] = (
                    "cancel requested - the decode loop checks this flag on every token "
                    "(GGUF stream chunk / torch StoppingCriteria), so the worker exits "
                    "instead of burning CPU"
                )
            return snap

    # -- synchronous /draft single-flight guard ------------------------------

    def acquire_sync(self) -> None:
        with self._lock:
            if self._active_id is not None:
                active = self._jobs.get(self._active_id) or {}
                raise DraftBusy(
                    "a draft is already in flight in this process (single-flight guard); "
                    "the synchronous /draft was refused before any model work.",
                    detail={
                        "active_job_id": self._active_id,
                        "active_status": active.get("status", "sync"),
                    },
                )
            self._active_id = "sync-" + uuid.uuid4().hex[:12]

    def release_sync(self) -> None:
        with self._lock:
            if self._active_id and str(self._active_id).startswith("sync-"):
                self._active_id = None

    # -- internals -----------------------------------------------------------

    def _snapshot_locked(self, job: Dict[str, Any]) -> Dict[str, Any]:
        end = job["finished_perf"] or time.perf_counter()
        stage_hint = job.get("stage_hint") or job["status"]
        stage_labels = {
            "queued": "Queued",
            "loading_model": "Loading local SOAP model",
            "generating": "Extracting clinical SOAP fields",
            "checking_safety": "Running medication & safety checks",
            "completed": "Completed",
            "failed": "Failed",
            "cancelled": "Cancelled",
        }
        snap: Dict[str, Any] = {
            "ok": True,
            "job_id": job["id"],
            "status": job["status"],
            "stage_label": stage_labels.get(stage_hint, str(job["status"])),
            "tokens_generated": int(job["tokens_generated"]),
            "max_new_tokens": int(job["max_new_tokens"]),
            "elapsed_s": round(float(end - job["created_perf"]), 2),
            "cancel_requested": bool(job["cancel_event"].is_set()),
            "provider": job["provider_obj"].name,
            "serving_mode": serving_mode_of(job["provider_obj"]),
            "model_scale": job.get("model_scale")
            or scale_label_for(job["provider_obj"], "soap"),
        }
        if job["status"] == "completed" and job["result"] is not None:
            snap["result"] = job["result"]
        if job["status"] == "failed" and job["error"] is not None:
            snap["error"] = job["error"]
        return snap

    def _run(self, job: Dict[str, Any]) -> None:
        started = time.perf_counter()
        provider_obj = job["provider_obj"]
        try:
            with self._lock:
                if job["cancel_event"].is_set():
                    job["status"] = "cancelled"
                    job["stage_hint"] = "cancelled"
                    return
                job["status"] = "loading_model"
                job["stage_hint"] = "loading_model"

            def progress(tokens: int) -> None:
                job["tokens_generated"] = int(tokens)
                if job["status"] in ("queued", "loading_model"):
                    job["status"] = "generating"
                job["stage_hint"] = "generating"

            kwargs: Dict[str, Any] = {}
            try:
                params = inspect.signature(provider_obj.draft).parameters
            except (TypeError, ValueError):
                params = {}  # type: ignore[assignment]
            if "cancel_event" in params:
                kwargs["cancel_event"] = job["cancel_event"]
            if "progress_cb" in params:
                kwargs["progress_cb"] = progress
            result = provider_obj.draft(
                job["transcript"],
                max_new_tokens=job["max_new_tokens_request"],
                note_format=job["format"],
                **kwargs,
            )
            if job["cancel_event"].is_set():
                raise DraftCancelled("draft cancelled by the operator")
            job["stage_hint"] = "checking_safety"
            result["guard"] = clinical_guard(result.get("draft", ""), job["transcript"])
            # tokens_generated is the REAL streamed count from progress_cb;
            # max_new_tokens is the cap the provider actually applied (it can
            # clamp on CPU), echoed honestly instead of the requested value.
            if result.get("max_new_tokens") is not None:
                job["max_new_tokens"] = int(result["max_new_tokens"])
            job["result"] = success_body(provider_obj, "soap", result, started)
            job["stage_hint"] = "completed"
            job["status"] = "completed"
        except DraftCancelled:
            job["stage_hint"] = "cancelled"
            job["status"] = "cancelled"
        except ProviderError as err:
            job["error"] = error_body(provider_obj, "soap", err)
            job["stage_hint"] = "failed"
            job["status"] = "failed"
        except Exception as err:
            wrapped = InferenceError(
                f"SOAP draft job failed in this environment: {type(err).__name__}: {err}. "
                "Nothing was silently substituted (no Gemini fallback)."
            )
            job["error"] = error_body(provider_obj, "soap", wrapped)
            job["stage_hint"] = "failed"
            job["status"] = "failed"
        finally:
            job["finished_perf"] = time.perf_counter()
            with self._lock:
                if self._active_id == job["id"]:
                    self._active_id = None
                self._prune_locked()

    def _prune_locked(self) -> None:
        """Keep a long-lived service bounded: retain the newest 24 terminal jobs.

        Each job holds its transcript, the full draft envelope and a provider
        reference; without pruning a day of drafts would grow the process
        forever. Active (non-terminal) jobs are never pruned.
        """
        overflow = len(self._jobs) - 24
        if overflow <= 0:
            return
        terminal = sorted(
            (
                jid
                for jid, job in self._jobs.items()
                if job["status"] in ("completed", "failed", "cancelled")
            ),
            key=lambda jid: self._jobs[jid]["created_at"],
        )
        for jid in terminal[:overflow]:
            self._jobs.pop(jid, None)


class TranscriptRequest(BaseModel):
    transcript: str
    provider: Optional[str] = None
    # Optional per-request generation cap (2026-10-31 local-speed). None =
    # provider default (448 vet_scribenote CPU default / 512 configured cap).
    max_new_tokens: Optional[int] = None
    # Optional output format (owner Fix 2, 2026-11-01): "vet_scribenote"
    # default (base-weights Qwen + hydrated 23-parameter veterinary objective,
    # structured `sections` in the envelope) or "medscribe" (legacy soap-lora
    # adapter behaviour). Unknown values are an honest 400 BEFORE any model
    # work - never a silent clamp.
    format: Optional[str] = None


class RomanRequest(BaseModel):
    text: str
    provider: Optional[str] = None


class UnloadRequest(BaseModel):
    component: str = "all"  # asr | soap | roman | all


def create_app(cfg: Optional[ServingConfig] = None) -> FastAPI:
    cfg = cfg or load_config()
    app = FastAPI(title=API_TITLE, version="4.0.0-scaffold")
    container = ServiceContainer(cfg)
    app.state.container = container
    app.state.cfg = cfg
    jobs = DraftJobManager(cfg)
    app.state.draft_jobs = jobs

    def _validate_draft(body: TranscriptRequest) -> Tuple[str, str]:
        """Honest 400 gates shared by sync /draft and async /draft/start.

        Every check runs BEFORE any model work or job creation: an empty or
        oversized transcript, an out-of-range cap, or an unknown format is a
        request error, never a silent clamp.
        """
        text = (body.transcript or "").strip()
        if not text:
            raise BadRequest("transcript is empty")
        if len(text) > cfg.transcript_max_chars:
            raise BadRequest(
                f"transcript has {len(text)} chars, over the {cfg.transcript_max_chars} cap "
                "(prepare_soap_data.py MAX_CHARS); shorten it or raise VOXSOAP_TRANSCRIPT_MAX_CHARS."
            )
        # Honest 400 BEFORE any model work: an out-of-range cap is a request
        # error, never a silent clamp (mirrors the /transcribe language gate).
        if body.max_new_tokens is not None and not (1 <= body.max_new_tokens <= cfg.draft_max_new_tokens):
            raise BadRequest(
                f"max_new_tokens must be between 1 and {cfg.draft_max_new_tokens} "
                f"(VOXSOAP_DRAFT_MAX_NEW_TOKENS); got {body.max_new_tokens}."
            )
        # Owner Fix 2: unknown format is an honest 400 BEFORE any model work.
        requested_format = (body.format or "vet_scribenote").strip().lower()
        if requested_format not in VET_NOTE_FORMATS:
            raise BadRequest(
                f"unsupported draft format {requested_format!r}; allowed: "
                "vet_scribenote | medscribe."
            )
        return text, requested_format

    def _respond(request: Request, provider_obj: Any, payload: Dict[str, Any], started: float) -> Dict[str, Any]:
        return success_body(
            provider_obj,
            getattr(request.state, "component", None),
            payload,
            started,
        )

    @app.exception_handler(ProviderError)
    def provider_error_handler(request: Request, exc: ProviderError):
        return JSONResponse(
            status_code=exc.status_code,
            content=error_body(
                getattr(request.state, "provider_obj", None),
                getattr(request.state, "component", None),
                exc,
            ),
        )

    @app.exception_handler(RequestValidationError)
    def validation_error_handler(request: Request, exc: RequestValidationError):
        return JSONResponse(
            status_code=422,
            content={
                "ok": False,
                "error": "validation_error",
                "message": str(exc)[:800],
                "model_scale": "UNAVAILABLE(request rejected before any model was needed)",
            },
        )

    @app.get("/health")
    async def health() -> Dict[str, Any]:
        c = app.state.container
        desc = c.ml.describe()
        return {
            "ok": True,
            "service": "voxsoap-ml-serving",
            "phase": "4-scaffold",
            "default_provider": c.cfg.default_provider,
            "providers": {
                "ml": {"is_mock": c.ml.is_mock, "components": desc},
                "gemini": {
                    "is_mock": c.gemini.is_mock,
                    "proxy_url_set": bool(c.cfg.gemini_proxy_url),
                    "note": None if c.cfg.gemini_proxy_url else (
                        "VOXSOAP_GEMINI_PROXY_URL is unset - provider=gemini answers honest 501"
                    ),
                },
            },
            "model_scale": {
                key: (desc.get(key, {}) or {}).get("model_scale", "UNKNOWN")
                for key in ("asr", "soap", "roman")
            },
            "soap_backend": (
                c.ml.soap_backend_summary()
                if hasattr(c.ml, "soap_backend_summary")
                else {"effective": "mock"}
            ),
            "policy": {
                "silent_gemini_fallback": "never - ML failure returns a controlled 5xx",
                "model_loading": "lazy/on-demand per component - startup loads nothing",
                "unload_helper": "POST /unload {component: asr|soap|roman|all} frees RAM (Windows safeguard)",
                "adapter_pairing": (
                    "adapter manifests must match the configured base id+revision exactly, else load refused"
                ),
            },
            "notes": [
                "Phase 4 SCAFFOLD: development/smoke use ONLY; no production-readiness claim is made.",
                "Default dirs point at the verified full-scale Phase-3 artifacts (run 20261030-165202, model_scale=FULL in both training manifests).",
                "Roman (Model C) is DEPRECATED (2026-10-29): its run-9 eval FAILED (mT5 sentinel collapse) and runs 10/11 also failed "
                "(loss plateau, then repetition loops; CER 6.8905) - /roman stays an honest 501 unless a supervised owner-approved "
                "adapter with a passing eval is configured.",
                "Real inference requires a 64-bit Python with torch; the current 32-bit 3.15 cannot import torch "
                "(the mocked contract suite still runs).",
            ],
        }

    @app.post("/transcribe")
    async def transcribe(
        request: Request,
        audio: UploadFile = File(...),
        provider: Optional[str] = Form(None),
        language: Optional[str] = Form(None),
    ):
        started = time.perf_counter()
        request.state.component = "asr"
        provider_obj = container.resolve(provider)
        request.state.provider_obj = provider_obj
        # Language contract: explicit "ur" / "en" / "auto" (default "ur", the
        # original scaffold behaviour). Anything else is an honest 400 - never
        # a silently wrong decoder tag.
        lang_key = (language or "ur").strip().lower()
        if lang_key not in ("ur", "en", "auto"):
            raise BadRequest(
                f"unsupported language {language!r}; allowed: ur | en | auto"
            )
        data = await audio.read()
        if len(data) > int(cfg.max_audio_mb * 1024 * 1024):
            raise BadRequest(f"audio upload of {len(data)} bytes exceeds VOXSOAP_MAX_AUDIO_MB={cfg.max_audio_mb}")
        try:
            samples, sample_rate = audio_utils.decode(data)
        except AudioDecodeError as err:
            raise BadRequest(f"audio could not be decoded: {err}") from err
        if sample_rate != cfg.target_sample_rate:
            raise BadRequest(
                f"decoded sample rate {sample_rate} != required {cfg.target_sample_rate}: this service accepts "
                f"{cfg.target_sample_rate} Hz audio (16 kHz); the server never silently resamples because a "
                "misread rate would corrupt ASR output."
            )
        result = await asyncio.to_thread(
            provider_obj.transcribe,
            samples,
            sample_rate=sample_rate,
            audio_bytes=data,
            language=lang_key,
        )
        result["audio"] = {
            "sample_rate": sample_rate,
            "filename": getattr(audio, "filename", None),
            "bytes": len(data),
            "decoded_samples": int(len(samples)),
        }
        return _respond(request, provider_obj, result, started)

    @app.post("/draft")
    async def draft(request: Request, body: TranscriptRequest):
        started = time.perf_counter()
        request.state.component = "soap"
        provider_obj = container.resolve(body.provider)
        request.state.provider_obj = provider_obj
        text, requested_format = _validate_draft(body)
        # Owner fix (2026-11-19): the synchronous route shares the SAME
        # single-flight guard as async jobs. Two concurrent 3B decodes on a
        # 2-core box is exactly the paging death spiral; an honest 409 is
        # returned BEFORE any model work and the slot is released in finally.
        jobs.acquire_sync()
        try:
            result = await asyncio.to_thread(
                provider_obj.draft,
                text,
                max_new_tokens=body.max_new_tokens,
                note_format=requested_format,
            )
        finally:
            jobs.release_sync()
        result["guard"] = clinical_guard(result.get("draft", ""), text)
        return _respond(request, provider_obj, result, started)

    @app.post("/draft/start")
    @app.post("/draft-jobs")
    async def draft_start(request: Request, body: TranscriptRequest):
        """Instant 202 + job_id - the request never holds the model open.

        The worker thread loads/generates; `GET /draft/status/{job_id}` polls
        pure in-memory state (<10 ms) and `POST /draft/cancel/{job_id}` flips
        the per-token cancel Event. Concurrent starts get an honest 409.
        """
        started = time.perf_counter()
        request.state.component = "soap"
        provider_obj = container.resolve(body.provider)
        request.state.provider_obj = provider_obj
        text, requested_format = _validate_draft(body)
        snap = jobs.start(
            provider_obj=provider_obj,
            transcript=text,
            fmt=requested_format,
            max_new_tokens=body.max_new_tokens,
        )
        return JSONResponse(
            status_code=202,
            content={
                "ok": True,
                "service": "voxsoap-ml-serving",
                "phase": "4-scaffold",
                "accepted": True,
                "job_id": snap["job_id"],
                "status": snap["status"],
                "format": requested_format,
                "max_new_tokens": snap["max_new_tokens"],
                "tokens_generated": snap["tokens_generated"],
                "elapsed_s": round(time.perf_counter() - started, 4),
                "provider": provider_obj.name,
                "serving_mode": serving_mode_of(provider_obj),
                "model_scale": snap["model_scale"],
                "poll": f"GET /draft/status/{snap['job_id']}",
                "cancel": f"POST /draft/cancel/{snap['job_id']}",
                "note": (
                    "draft accepted (202): a worker thread loads the model and streams "
                    "progress; poll the status route every ~2 s. No long-lived POST is held "
                    "open, so a proxy budget can no longer orphan a CPU decode. Jobs live in "
                    "this serving process only - a restart clears them."
                ),
            },
        )

    @app.get("/draft/status/{job_id}")
    @app.get("/draft-jobs/{job_id}")
    async def draft_status(request: Request, job_id: str):
        request.state.component = "soap"
        snap = jobs.snapshot(job_id)
        snap.setdefault("service", "voxsoap-ml-serving")
        snap.setdefault("phase", "4-scaffold")
        return snap

    @app.post("/draft/cancel/{job_id}")
    @app.post("/draft-jobs/{job_id}/cancel")
    async def draft_cancel(request: Request, job_id: str):
        request.state.component = "soap"
        snap = jobs.cancel(job_id)
        snap.setdefault("service", "voxsoap-ml-serving")
        snap.setdefault("phase", "4-scaffold")
        return snap

    @app.post("/roman")
    def roman(request: Request, body: RomanRequest):
        started = time.perf_counter()
        request.state.component = "roman"
        provider_obj = container.resolve(body.provider)
        request.state.provider_obj = provider_obj
        text = (body.text or "").strip()
        if not text:
            raise BadRequest("text is empty")
        return _respond(request, provider_obj, provider_obj.roman(text), started)

    @app.post("/unload")
    def unload(request: Request, spec: Optional[UnloadRequest] = None):
        started = time.perf_counter()
        request.state.component = None
        request.state.provider_obj = container.ml
        which = (spec.component if spec else "all").strip().lower()
        if which == "all":
            keys = ["asr", "soap", "roman"]
        elif which in ("asr", "soap", "roman"):
            keys = [which]
        else:
            raise BadRequest(f"unknown component {which!r}; allowed: asr | soap | roman | all")
        ml = container.ml
        if not hasattr(ml, "unload"):
            raise BadRequest("the active provider holds no unloadable state")
        status = {key: bool(ml.unload(key)) for key in keys}
        desc = ml.describe()
        result = {
            "unload_status": status,
            "model_scale_after": {
                key: (desc.get(key, {}) or {}).get("model_scale", "UNKNOWN") for key in keys
            },
            "note": (
                "Windows RAM safeguard: model references dropped, gc collected, CUDA cache emptied when torch is "
                "present. To SWAP adapters, set the new VOXSOAP_*_ADAPTER_DIR values and restart the process."
            ),
        }
        return _respond(request, container.ml, result, started)

    return app


app = create_app()

if __name__ == "__main__":
    import uvicorn

    cfg = app.state.cfg
    uvicorn.run(app, host=cfg.host, port=cfg.port)
