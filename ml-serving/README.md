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
| `POST /transcribe` | multipart `audio` (16 kHz PCM WAV), form `provider` optional | ASR transcription; other sample rates => honest 400. English (`language=en`) decodes with the ADAPTER-DISABLED base Whisper weights (owner Fix 1) and audio longer than 20 s is processed as sequential 20 s chunks (silent chunks skipped, reported in `note`) |
| `POST /draft` | JSON `{transcript, provider?, max_new_tokens?, format?}` | `format:"vet_scribenote"` (DEFAULT): base-weights Qwen + deterministic hydration of ALL 23 canonical objective parameters (missing/bare-placeholder values -> "Not mentioned") + a verbatim-trace gate that DROPS stated values the transcript never contains; envelope carries `draft` + `sections{subjective, objective_map, objective_text, assessment, plan}`. `format:"medscribe"`: legacy soap-lora adapter behaviour. Unknown format => honest 400 |
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
6. **Objective values are transcribed, never invented (2026-11-03).** In the
   vet_scribenote draft every stated parameter value must TRACE verbatim to
   the consultation transcript; untraceable values are DROPPED into
   "Not mentioned" (counted in the envelope note) — the same
   drop-never-rewrite doctrine the frontend FR-27 claim filter enforces. Bare
   model placeholders ("Normal", "WNL", "not examined", ...) collapse the
   same way; a fabricated medical value can never reach a card.

## Owner fixes 2026-11-01/03 (ASR speed + vet-scribenote draft)

1. **ASR (Fix 1).** The ur-LoRA adapter was trained on FLEURS clips — short
   single sentences padded to 30 s — so on DENSE continuous English dialogue
   it prematurely emitted EOS. English now decodes with the UNCORRUPTED base
   `openai/whisper-small` weights (`model.disable_adapter()` inside
   `generate`); Urdu keeps the adapter; "auto" also keeps it (explicit `en`
   is the escape hatch). Audio longer than 20 s is decoded as sequential
   20 s chunks (320,000 samples, no overlap; a boundary word may clip, stated
   in `note`), silent chunks are skipped, and prev-chunk conditioning is OFF.
   CPU speed-up: `torch.set_num_threads(cpu_count)` always on CPU;
   `VOXSOAP_ASR_QUANT=1` additionally enables dynamic qint8 quantization as
   an explicit OPT-IN (default OFF: PEFT/qint8 interaction + eval-parity
   risk — never silently change a verified recipe).
2. **Draft (Fix 2).** Default `format:"vet_scribenote"` = BASE Qwen weights +
   the strict veterinary prompt (only transcript-stated parameters, drafted
   as `Name: value` lines) + deterministic Python post-processing that
   hydrates ALL 23 canonical parameters (UNSTATED -> `Not mentioned`)
   exactly in owner order, normalizes every section bullet, and returns the
   structured `sections` object the frontend maps into the workspace cards.
   `format:"medscribe"` preserves the legacy adapter behaviour (and its 256
   CPU token cap; vet_scribenote's hydrated shape gets 448, still under the
   512 configured maximum). `hf_xet`: UNINSTALLED in `.venv-ml64` (its
   import crashed huggingface_hub 0.36.2 downloads) — snapshot downloads
   work cleanly without it.

## Tests (mocked vs real)

```powershell
# mocked contract suite (no torch needed; runs on 32-bit Python too):
py -m pytest ml-serving/tests -m "not real" -v
# REAL inference gate (needs torch + adapters; skips honestly elsewhere):
py -m pytest ml-serving/tests -m real -v
```

Mocked tests use fake providers reporting `serving_mode="mocked-test-double"`
in every response (48 tests: the /transcribe language contract, the /draft
max_new_tokens override, and the 15-test vet_scribenote contract suite —
canonical 23-parameter order, Leo-consultation content gates, placeholder
collapse and the verbatim-trace drop gate). Real-inference tests are
additionally gated by `pytest.mark.real` (4 tests: health, real /transcribe,
roman-501, real /draft -
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

Still no real inference ON THIS MACHINE outside the venv: the interpreters
installed outside `.venv-ml64` are **32-bit** Pythons (3.15-32, 2.7-32) and
torch publishes no win32 wheels, so `torch`/`transformers` cannot run in them -
the mocked suite (48 tests) runs
there; the real gate ran on Colab, and the Phase-5 plan
(`reports/phase5_integration_plan.md`) sets up a 64-bit Python 3.12 venv to
close that gap (§10 records the 2026-11-03 local verification in `.venv-ml64`,
where `hf_xet` had to be UNINSTALLED — an environment exception documented
there). Re-run the gate after any re-pin; the 4th real test (real
/draft with the full-scale SOAP adapter) is the live regression guard for the
drift caught above. `/roman` stays 501 (Model C **DEPRECATED**). ML failures
in a torch-absent process surface as honest 503s - never a Gemini swap.

**Local-ML transport + hygiene contract (2026-11-04):** the Next.js engine calls
this service through `node:http` (NOT undici fetch — its fixed 300 s
`headersTimeout` was live-proven killing minutes-long `/draft` calls with
`UND_ERR_HEADERS_TIMEOUT`, and `AbortSignal.timeout` cannot raise that cap),
after a 2 s `/health` pre-check so a dead service fails in seconds with the
`start-voxsoap-local.bat` guidance instead of burning the whole budget. A
5-minute recording is 15 × 20 s chunk decodes: an unexpected per-chunk failure
is re-raised as a CONTROLLED `InferenceError` naming `[start:end]` and the
chunk index (honest `ok:false, error:'inference_error'` HTTP 503 — never a
worker crash), and on CPU every finished chunk releases its tensors
(`del` + `gc.collect()`) between decodes so long consults keep flat resident
memory. Latency honesty: a WARM `/draft` measured ~450-470 s (inside the 900 s
`ML_DRAFT_TIMEOUT_MS` budget); the COLD first draft after a service restart
remains ~989-1132 s — pre-warm the service once (any small `/draft`) before
the first real session, or raise `VOXSOAP_ML_DRAFT_TIMEOUT_MS`.

## Owner reliability batch 2026-11-04/05 (proxy node:http + draft hygiene)

- The PANEL-facing Next.js proxy (`/api/voxsoap/[route]`) moved its POSTs from
  global `fetch` - undici enforces a FIXED 300 s `headersTimeout` there, so the
  browser panel died at ~5:00 with a wrong `502 service_unreachable` - to
  `node:http` with the whole budget on `req.setTimeout(TIMEOUT_MS)` (default
  900 000 ms, `VOXSOAP_TIMEOUT_MS`). Budget elapse fires the
  `TIMEOUT_BUDGET_<N>s` sentinel → honest **504 `upstream_timeout`**; a
  refusal stays **502 `service_unreachable` (code=ECONNREFUSED)**. GET /health
  stays on fetch (≤30 s; instant answers).
- CPU draft hygiene: the intra-op pool is bounded to `max(2, cpus - 2)` for the
  long draft (`VOXSOAP_DRAFT_THREADS` override; never up-sizes another session's
  explicit choice) so the uvicorn loop keeps answering `/health` while torch
  generates (measured 5-202 ms polls across a 25-minute draft); `transcribe()`
  re-applies the full-core Fix-1 saturation on every call. Before generating,
  `draft()` runs `gc.collect()` and - when free RAM is under 2 GB
  (`VOXSOAP_ASR_RELEASE_FREE_RAM_GB`) - drops the resident Whisper first; the
  next `/transcribe` reloads it on demand.
- Measured on the owner 4-logical-core box (drill 13/13 through the proxy): the
  sustained 1 108.8 s long draft answered **HTTP 200** with the full
  vet_scribenote contract (23-parameter objective_map + deterministic guard
  note) on ONE socket - undici would have killed it at 300 s; under the DEFAULT
  900 s budget a heavily-paged box (≤2 GB free) honestly 504s at exactly
  900.1 s. Windows sleeps on its IDLE timer (not CPU load) - a system-awake
  flag (`SetThreadExecutionState`) is required for unattended long runs; when
  the box is unavoidably loaded, raise `VOXSOAP_TIMEOUT_MS` above the default.
