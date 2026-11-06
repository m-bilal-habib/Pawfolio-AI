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
   CPU token ceiling; vet_scribenote's hydrated shape uses the configured
   320 default — the 2026-11-05 realignment: the 23-parameter Objective
   hydration is deterministic Python post-processing, so the contract shape
   never depended on generating 448/512 tokens, and 320 cuts ~35% off CPU
   decode). `hf_xet`: UNINSTALLED in `.venv-ml64` (its
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
memory. Latency honesty (2026-11-05/06 realignment): the proxy budget default
is now 1 200 000 ms (20 min, `VOXSOAP_TIMEOUT_MS`); a WARM `/draft` measured
~450-470 s at ~8 GB free (inside the budget), and the client panel budgets
proxy + 15 s so the proxy's controlled 504 always reaches the browser first.
The COLD first draft (bf16 3B load + generation) is the long pole — measured
1 529 s under memory pressure even with the 320-token cap (drill-8a), with a
~770-810 s calm-box projection; raise `VOXSOAP_TIMEOUT_MS` when the box is
loaded (the drill dev instance ran 1 800 000 ms).

## Owner reliability batch 2026-11-04/05 (proxy node:http + draft hygiene)

- The PANEL-facing Next.js proxy (`/api/voxsoap/[route]`) moved its POSTs from
  global `fetch` - undici enforces a FIXED 300 s `headersTimeout` there, so the
  browser panel died at ~5:00 with a wrong `502 service_unreachable` - to
  `node:http` with the whole budget on `req.setTimeout(TIMEOUT_MS)`
  (`VOXSOAP_TIMEOUT_MS`; the default was 900 000 ms at that time, raised to
  1 200 000 ms in the 2026-11-05/06 realignment below). Budget elapse fires the
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

## Owner budget realignment batch 2026-11-05/06 (the ~15:00 504 on a real consult)

The owner's ML Assistive Draft panel died at ~15:00 on the exact 900 s sentinel while
the Leo consult (~2 900 chars) was still generating on CPU. Nothing dishonest
happened — the DEFAULT budget was tighter than the measured cold-load reality.
Every layer realigned; honesty untouched:

- `route.ts`: proxy budget default 900 000 → **1 200 000 ms** (20 min;
  `VOXSOAP_TIMEOUT_MS` still overrides) and the `TIMEOUT_BUDGET_<N>s` sentinel
  logs the effective seconds accurately.
- `voxsoap-ml.client.ts`: client abort budget = proxy + **15 s** (1 215 000 ms) so
  the proxy's controlled 504 always reaches the browser before an opaque
  client-side abort.
- `config.py` + `.env.example`/`.env.local`: CPU draft ceiling default 512 → **320**
  (`VOXSOAP_DRAFT_MAX_NEW_TOKENS`). The 23-parameter Objective hydration is
  deterministic and code-side (unstated parameters stay "Not mentioned"), so the
  contract shape never depended on generating 448/512 tokens; 320 cuts ~35% off
  CPU decode. The 448/256 provider clamps remain ceilings for env-raised configs.
- `providers.py`: the pre-draft ASR release is now **UNCONDITIONAL** on CPU
  (`VOXSOAP_ASR_RELEASE_BEFORE_DRAFT=1`, opt-out `=0`; the old conditional
  <2.0 GB-free rule fired too late on the thrash days) and runs BEFORE
  `_load_soap()` — the device resolves pre-load, so the bf16 3B load peak never
  shares RAM with fp32 Whisper. Draft decode switched to
  `torch.inference_mode()`; intra-op pool default `max(2, cpus - 1)` (3 of the 4
  logical cores here; `VOXSOAP_DRAFT_THREADS` still overrides, never up-sizes).
- `MLAssistPanel.tsx`: drafting status carries the operator guidance —
  "typically takes 4-8 minutes on warm models and up to 15-18 minutes on a cold
  initial load" with the elapsed timer; a budget 504 PRESERVES the transcript and
  offers "⚡ Retry Warm Draft (Model is now loaded in memory)".

Drill evidence (2026-11-06; fresh ES_CONTINUOUS holder; twin-pair zombie rule
respected; one-shot mode via `PROBE_SKIP_PREWARM=1`):

- Cold one-shot (drill-8a): the FULL 2 935-char consult rode the FIRST request of
  a clean service — **HTTP 200 in 1 528.8 s** on ONE socket with 11/11 surgical
  checks (23/23 objective parameters, 19 hydrated lines, honest
  `max_new_tokens=320` echo, deterministic guard note, zero undici, zero Gemini).
- New-default sentinel precision: honest 504 at exactly **1 200.1 s** (drill-7),
  matching the 900.1 s drill-5 proof to 0.1 s; the load-only cold shot answered
  200 @ **472.6 s** (drill-7 pre-warm) — the load alone is never the failure.
- Box-condition honesty: 1 528.8 s = ~470 s load + ~1 050 s generation
  (~3.3 s/token) with free RAM collapsed mid-decode; the CALM-box projection is
  ~770-810 s (~1 s/token). When the box is unavoidably loaded, raise
  `VOXSOAP_TIMEOUT_MS` (this drill's dev instance ran 1 800 000 ms; probe client
  2 000 000 ms) — the panel copy and ⚡ retry already prepare the user for the wait.
- Warm fast-path one-shot (drill-8b, immediately after 8a on the resident model):
  **HTTP 200 in 954.0 s** (11/11, same full contract) at ~0.7 GB free — beats the
  warm 448-token paged benchmark (1 108.8 s, drill-6) by ~14% on a WORSE box
  (the 320-token ceiling win, live), and it fits the new 1 200 s default with
  margin where the OLD 900 s default would have honestly 504'd by 54 s. The
  < 360 s warm criterion is the CALM-box case (~290-340 s extrapolated from the
  historical ~450-470 s @ ~8 GB free 448-token curve); today's thrashing box
  documents the paged truth instead of faking the calm number.
