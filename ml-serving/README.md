# VoxSOAP ML Serving (Phase 4 scaffold)

FastAPI service that will host the VoxSOAP ML components (Whisper ASR LoRA,
Qwen SOAP QLoRA draft; the mT5 Roman-Urdu transliteration component is
DEPRECATED - see below) on the user's Windows
machine; the Next.js app calls it over `http://127.0.0.1:<port>` (contract
serving section).

**Status: SCAFFOLD, development only.** Phase-2 SMOKE adapters are used for
development/shake-out. Nothing here is a production-readiness claim: real
inference, complete workflow tests and veterinarian-reviewed cases are still
required before this replaces the existing Gemini path (Phase 5).

## Layout

| File | Purpose |
| --- | --- |
| `app.py` | FastAPI routes + response envelope (lazy loading, no-fallback policy) |
| `config.py` | `VOXSOAP_*` env-driven config; defaults point at the unpacked Phase-2 smoke export |
| `providers.py` | `MLProvider` (lazy load / unload / swap) and `GeminiProxyProvider` (explicit-only passthrough) |
| `audio_utils.py` | audio decode (soundfile, stdlib-WAV fallback) |
| `guards.py` | deterministic clinical-guard annotations (ported from `evaluate_soap.py`) |
| `tests/` | mocked contract suite + separately-marked real-inference tests |

## Quickstart

```powershell
# from D:\Pawfolio AI\ml-serving
py -m pip install -r requirements-serving.txt          # API layer (mocked-testable)
py app.py                                              # or: py -m uvicorn app:app --host 127.0.0.1 --port 8321
# GET http://127.0.0.1:8321/health
```

Note: the default directories point at the verified **run-9** export
(`ml-training/artifacts/unpacked_voxsoap_ml_exports_20261028-142956/`,
`model_scale=FULL` in every training manifest). Retarget with
`VOXSOAP_*_ADAPTER_DIR`. The Roman (Model C) component is **DEPRECATED**
(2026-10-29): three training recipes (runs 9/10/11) all failed their
evaluations - mT5 sentinel collapse (CER 0.9142), loss plateau (CER 6.1456),
then repetition loops (CER 6.8905, exact_match 0.0). `VOXSOAP_ROMAN_ADAPTER_DIR`
stays a diagnostics-only override; `/roman` answers an honest 501 by design.

## Routes

| Route | Body | Behaviour |
| --- | --- | --- |
| `GET /health` | - | component/status/scale report; loads nothing |
| `POST /transcribe` | multipart `audio` (16 kHz PCM WAV), form `provider` optional | ASR LoRA transcription; other sample rates => honest 400 |
| `POST /draft` | JSON `{transcript, provider?}` | SOAP draft + deterministic guard annotations |
| `POST /roman` | JSON `{text, provider?}` | **501** - Model C DEPRECATED (runs 9/10/11 failed); diagnostics-only via `VOXSOAP_ROMAN_ADAPTER_DIR` |
| `POST /unload` | JSON `{component: asr|soap|roman|all}` | frees weights + gc + CUDA cache; swap = change env, restart |

Every response (success **and** controlled error) carries:

```json
"provider": "ml", "serving_mode": "real-provider|mocked-test-double",
"model_scale": "<label|source>", "note": "..."
```

## model_scale labels (never fabricated)

| Label | Meaning |
| --- | --- |
| `SMOKE` / `FULL` | recorded in the adapter's `training_manifest.json` (phase-3 artifacts) |
| `SMOKE(assumed: ...train_rows...)` | phase-2 manifests predate the tag; derived from small train_rows (ASR 180, SOAP 100) |
| `UNTAGGED(assumed: ...)` | derived from larger train_rows |
| `UNKNOWN(...)` | no/corrupt manifest |
| `NOT_APPLICABLE(gemini)` | gemini proxy carries no local ML weights |

## Honesty policies (enforced, tested)

1. **No silent Gemini fallback.** A failing ML call returns a controlled 5xx
   (`inference_error` / `not_configured` / `adapter_compatibility_error`). The
   Gemini proxy is used ONLY when the request explicitly selects
   `provider:"gemini"` (or `VOXSOAP_DEFAULT_PROVIDER=gemini`).
2. **Adapter-not-a-model.** Each adapter is loaded only together with the
   exact base checkpoint id+revision recorded in its `training_manifest.json`;
   a mismatch REFUSES to load (503 with explanation).
3. **Lazy loading / Windows RAM safeguard.** Starting the process loads
   nothing. Weights load on the first request per component; `/unload` frees
   RAM (bitsandbytes 4-bit is Linux-only, so the 3B SOAP base occupies its
   full dtype size on Windows when loaded).
4. **Guard annotations are NOT a verdict.** `guards.py` reuses the section /
   number / medicine-fact arithmetic from `evaluate_soap.py` to annotate
   drafts; the veterinarian remains the reviewer of record.
5. **16 kHz audio or honest 400.** The server never silently resamples.

## Tests (mocked vs real)

```powershell
# mocked contract suite (no torch needed; runs on 32-bit Python too):
py -m pytest ml-serving/tests -m "not real" -v
# REAL inference gate (needs torch + adapters; skips honestly elsewhere):
py -m pytest ml-serving/tests -m real -v
```

Mocked tests use fake providers reporting `serving_mode="mocked-test-double"`
in every response. Real-inference tests are additionally gated by `pytest.mark.real`.

## Real-inference gate status (read before relying on this)

Blocked on this machine: the only installed interpreters are **32-bit**
Pythons (3.15-32, 2.7-32) and torch publishes no win32 wheels, so
`torch`/`transformers` cannot run - the route gate therefore reports an
honest 503 `inference_error` until one of:

1. a **64-bit Python** (3.11-3.13) is installed and `requirements-serving.txt`
   + a torch/CUDA build are installed into it, or
2. the serving check is run in **Colab** (torch 2.11+cu130 environment) and
   results are copied back as the gate evidence.

Until then: `GET /health` works (manifest-level introspection), all route
contracts are mock-verified, and every error path is proven by the mocked
suite. Torch-absent ML failures surface as honest 503s - never a Gemini swap.
