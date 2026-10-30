# VoxSOAP ML Serving (Phase 4 scaffold)

FastAPI service that will host the VoxSOAP ML components (Whisper ASR LoRA,
Qwen SOAP QLoRA draft; the mT5 Roman-Urdu transliteration component is
DEPRECATED - see below) on the user's Windows
machine; the Next.js app calls it over `http://127.0.0.1:<port>` (contract
serving section).

**Status: SCAFFOLD, development only.** The verified FULL-SCALE Phase-3
adapters (run 20261030-165202) are the default development artifacts. Nothing
here is a production-readiness claim: the real-inference gate, the complete
clinical workflow and veterinarian-reviewed cases are still required before
this replaces the existing Gemini path (Phase 5).

## Layout

| File | Purpose |
| --- | --- |
| `app.py` | FastAPI routes + response envelope (lazy loading, no-fallback policy) |
| `config.py` | `VOXSOAP_*` env-driven config; defaults point at the verified full-scale Phase-3 export (run 20261030-165202) |
| `providers.py` | `MLProvider` (lazy load / unload / swap) and `GeminiProxyProvider` (explicit-only passthrough) |
| `audio_utils.py` | audio decode (soundfile, stdlib-WAV fallback) |
| `guards.py` | deterministic clinical-guard annotations (ported from `evaluate_soap.py`) |
| `tests/` | mocked contract suite + separately-marked real-inference tests |

## Quickstart

```powershell
# from D:\Pawfolio AI\ml-serving
py -m pip install -r requirements-serving.txt          # API layer (mocked-testable)
py -m pip install -r requirements-serving-ml.txt       # REAL inference - EXACT verified pins
py app.py                                              # or: py -m uvicorn app:app --host 127.0.0.1 --port 8321
# GET http://127.0.0.1:8321/health
```

Note: the default directories point at the verified FULL-SCALE **Phase-3**
export (`ml-training/artifacts/unpacked_voxsoap_ml_exports_20261030-165202/`,
`model_scale=full` in both training manifests; verification details and
SHA-256s: `ml-training/reports/phase3_gate_report.md`). Retarget with
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
in every response (24 tests). Real-inference tests are additionally gated by
`pytest.mark.real` (4 tests: health, real /transcribe, roman-501, real /draft -
the 4th needs CUDA or `VOXSOAP_REAL_DRAFT_FORCE=1` + ~13 GB free CPU RAM,
otherwise it skips honestly).

## Real-inference gate status (read before relying on this)

**Phase 4 REAL-INFERENCE GATE: PASSED (2026-10-30, owner's Colab Tesla T4,
full-scale `20261030-165202` adapters, model_scale FULL on asr + soap).**
`pytest -m real` **4/4 PASSED** and all four live endpoint probes returned
200 OK (`/health`, `/transcribe` real Whisper Urdu inference, `/draft` real
QLoRA SOAP note with guard annotations, `/unload`). Full evidence, chronology,
integrity chain and honest limitations: `reports/phase4_gate_report.md`.
Phase 5 (Next.js integration) is planned in `reports/phase5_integration_plan.md`.

Chronology kept honestly: the FIRST same-day attempt (unpinned resolve,
`transformers` newer than the verified 4.48.3) passed 3/3 and its live
`POST /draft` probe CAUGHT a real bug — newer transformers return a
`BatchEncoding` from `apply_chat_template(..., return_tensors="pt")` where
4.48.3 returned a raw tensor, so the SOAP draft path crashed
(`KeyError: 'shape'`, the raw exception escaping as an uncontrolled 500).
Fixed in `providers.py` at commit `6a07ed8`: explicit `return_dict=True` +
`_unwrap_chat_prompt()` (accepts both shapes), version-aware
`dtype`/`torch_dtype` kwargs, `clean_up_tokenization_spaces=True` pinned
explicitly (the verified 4.48.3 eval default), every ML inference body
wrapping unexpected failures as controlled `InferenceError` → 503, and the
pinned runtime in `requirements-serving-ml.txt` (torch 2.11.0,
transformers 4.48.3, peft 0.18.1, accelerate 1.3.0, soundfile 0.13.1,
bitsandbytes 0.49.2) so pip never pulls an untested major (e.g.
transformers 5.x). The pinned re-run then passed 4/4.

Still no real inference ON THIS MACHINE: the only installed interpreters are
**32-bit** Pythons (3.15-32, 2.7-32) and torch publishes no win32 wheels, so
`torch`/`transformers` cannot run locally - the mocked suite (24 tests) runs
there; the real gate ran on Colab, and the Phase-5 plan
(`reports/phase5_integration_plan.md`) sets up a 64-bit Python 3.12 venv to
close that gap. Re-run the gate after any re-pin; the 4th real test (real
/draft with the full-scale SOAP adapter) is the live regression guard for the
drift caught above. `/roman` stays 501 (Model C **DEPRECATED**). ML failures
in a torch-absent process surface as honest 503s - never a Gemini swap.
