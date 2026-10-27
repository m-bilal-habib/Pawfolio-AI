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
 * /roman answers honest 501 until a Model C adapter is configured.
"""
from __future__ import annotations

import time
from typing import Any, Dict, Optional

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import audio_utils
from audio_utils import AudioDecodeError
from config import ServingConfig, load_config
from guards import clinical_guard
from providers import (
    BadRequest,
    GeminiProxyProvider,
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


class TranscriptRequest(BaseModel):
    transcript: str
    provider: Optional[str] = None


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

    def _serving_mode(provider_obj: Any) -> str:
        return "mocked-test-double" if getattr(provider_obj, "is_mock", False) else "real-provider"

    def _scale_label(component: Optional[str], provider_obj: Any) -> str:
        try:
            return provider_obj.scale_for(component)[0]
        except ProviderError as err:
            return f"UNAVAILABLE: {str(err.message)[:160]}"
        except Exception as err:  # defensive - even introspection must not 500
            return f"UNAVAILABLE ({type(err).__name__}: {err})"

    def _respond(request: Request, provider_obj: Any, payload: Dict[str, Any], started: float) -> Dict[str, Any]:
        body: Dict[str, Any] = {
            "ok": True,
            "service": "voxsoap-ml-serving",
            "phase": "4-scaffold",
            "provider": provider_obj.name,
            "serving_mode": _serving_mode(provider_obj),
            "model_scale": _scale_label(getattr(request.state, "component", None), provider_obj),
            "latency_s": round(time.perf_counter() - started, 4),
        }
        body.update(payload)
        return body

    @app.exception_handler(ProviderError)
    def provider_error_handler(request: Request, exc: ProviderError):
        provider_obj = getattr(request.state, "provider_obj", None)
        body: Dict[str, Any] = {
            "ok": False,
            "error": exc.code,
            "message": exc.message,
            "detail": exc.detail,
            "provider": provider_obj.name if provider_obj else getattr(request.state, "provider_name", None),
            "serving_mode": _serving_mode(provider_obj) if provider_obj else None,
            "model_scale": (
                _scale_label(getattr(request.state, "component", None), provider_obj)
                if provider_obj else "UNAVAILABLE(no provider resolved)"
            ),
            "note": "controlled error - the request was NOT silently rerouted to another provider",
        }
        return JSONResponse(status_code=exc.status_code, content=body)

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
    def health() -> Dict[str, Any]:
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
                "Default dirs point at the unpacked PHASE-2 SMOKE adapters (model_scale derives as SMOKE(assumed)).",
                "Real inference requires a 64-bit Python with torch; the current 32-bit 3.15 cannot import torch "
                "(the mocked contract suite still runs).",
            ],
        }

    @app.post("/transcribe")
    async def transcribe(
        request: Request,
        audio: UploadFile = File(...),
        provider: Optional[str] = Form(None),
    ):
        started = time.perf_counter()
        request.state.component = "asr"
        provider_obj = container.resolve(provider)
        request.state.provider_obj = provider_obj
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
        result = provider_obj.transcribe(samples, sample_rate=sample_rate, audio_bytes=data)
        result["audio"] = {
            "sample_rate": sample_rate,
            "filename": getattr(audio, "filename", None),
            "bytes": len(data),
            "decoded_samples": int(len(samples)),
        }
        return _respond(request, provider_obj, result, started)

    @app.post("/draft")
    def draft(request: Request, body: TranscriptRequest):
        started = time.perf_counter()
        request.state.component = "soap"
        provider_obj = container.resolve(body.provider)
        request.state.provider_obj = provider_obj
        text = (body.transcript or "").strip()
        if not text:
            raise BadRequest("transcript is empty")
        if len(text) > cfg.transcript_max_chars:
            raise BadRequest(
                f"transcript has {len(text)} chars, over the {cfg.transcript_max_chars} cap "
                "(prepare_soap_data.py MAX_CHARS); shorten it or raise VOXSOAP_TRANSCRIPT_MAX_CHARS."
            )
        result = provider_obj.draft(text)
        result["guard"] = clinical_guard(result.get("draft", ""), text)
        return _respond(request, provider_obj, result, started)

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
