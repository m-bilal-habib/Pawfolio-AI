# Phase 5 Integration Plan — Next.js frontend ↔ local VoxSOAP ML service

Written 2026-10-30 after the Phase-4 serving gate PASSED (see `phase4_gate_report.md`).
Contract unchanged: the Next.js app calls the Python FastAPI service over
`http://127.0.0.1:<port>`; every envelope keeps `provider` / `serving_mode` /
`model_scale`; an ML failure is surfaced as a controlled 5xx — **never** a silent
Gemini swap. The service is framework-agnostic (plain HTTP), so a Django backend
could consume the same endpoints identically.

## 1. Local background service (Windows)

1. **64-bit runtime (machine currently has only 32-bit Pythons):**
   ```powershell
   winget install --id Python.Python.3.12 -e
   py -3.12 -m venv "D:\Pawfolio AI\.venv-ml64"
   "D:\Pawfolio AI\.venv-ml64\Scripts\python" -m pip install --upgrade pip
   "D:\Pawfolio AI\.venv-ml64\Scripts\pip" install torch --index-url https://download.pytorch.org/whl/cpu
   "D:\Pawfolio AI\.venv-ml64\Scripts\pip" install -r "D:\Pawfolio AI\ml-serving\requirements-serving.txt" -r "D:\Pawfolio AI\ml-serving\requirements-serving-ml.txt"
   # sanity: mocked suite must be 24/24 there too
   "D:\Pawfolio AI\.venv-ml64\Scripts\python" -m pytest "D:\Pawfolio AI\ml-serving\tests" -m "not real" -q
   ```
   RAM reality on this 15.9 GB machine: `/transcribe` (whisper-small fp32 ≈ 1-2 GB) is
   comfortable; a real `/draft` loads the 3B base in **fp32 ≈ 12-13 GB** — run it with a
   mostly-idle machine. For a production-feel path later: repeat the torch install with the
   CUDA index on a GPU machine (code resolves `device=auto`, no code change).

2. **Run it once (manually) and verify:**
   ```powershell
   "D:\Pawfolio AI\.venv-ml64\Scripts\python" -m uvicorn app:app --app-dir "D:\Pawfolio AI\ml-serving" --host 127.0.0.1 --port 8321
   curl http://127.0.0.1:8321/health
   ```
   `model_scale` must read `FULL` (asr + soap) with `roman` UNKNOWN/501 (deprecated).

3. **Auto-start at login (background service):**
   - Simple: drop one `.bat` in `shell:startup`:
     ```bat
     "D:\Pawfolio AI\.venv-ml64\Scripts\python.exe" -m uvicorn app:app --app-dir "D:\Pawfolio AI\ml-serving" --host 127.0.0.1 --port 8321 >> "%USERPROFILE%\voxsoap-ml-serving.log" 2>&1
     ```
   - Robust: install **NSSM** (`nssm install VoxSoapMLServing "D:\Pawfolio AI\.venv-ml64\Scripts\python.exe" -m uvicorn app:app --app-dir "D:\Pawfolio AI\ml-serving" --host 127.0.0.1 --port 8321`) with `nssm set ... AppStdout`/`AppStderr` to a log file and auto-restart. Binding stays localhost-only by config (`host: 127.0.0.1`, `port: 8321`) — never widen without VPN/auth work.

## 2. Next.js proxy route (`/api/voxsoap/[route]`)

One proxy module, `runtime = "nodejs"` (multipart file handling needs node streams):

```ts
// app/api/voxsoap/[route]/route.ts
export const runtime = "nodejs";

const BASE = process.env.VOXSOAP_BASE_URL ?? "http://127.0.0.1:8321";
const ROUTE_TIMEOUT_MS = Number(process.env.VOXSOAP_TIMEOUT_MS ?? 300_000);

export async function GET() {
  const r = await fetch(`${BASE}/health`, { cache: "no-store" });
  return new Response(await r.text(), { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/json" } });
}

export async function POST(req: Request, { params }: { params: { route: string } }) {
  const route = params.route;                       // transcribe | draft | roman | unload
  const res = await fetch(`${BASE}/${route}`, {
    method: "POST",
    body: await req.arrayBuffer(),                  // byte-for-byte passthrough
    headers: { "content-type": req.headers.get("content-type") ?? "" },
    signal: AbortSignal.timeout(ROUTE_TIMEOUT_MS),  // draft on CPU may take minutes
  });
  // Pass status AND body THROUGH verbatim (400/422/501/503 + envelope) — the UI
  // renders the honest ML failure; the proxy MUST never synthesize a Gemini answer.
  return new Response(await res.text(), { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
}
```

- `.env.local`: `VOXSOAP_BASE_URL=http://127.0.0.1:8321`.
- TypeScript envelope types to mirror (from `app.py`): success =
  `{ ok: true, service, phase, provider, serving_mode: "real-provider" | "mocked-test-double", model_scale, latency_s, ...payload }` with
  `payload.text` (transcribe) / `payload.draft` (draft) / `payload.roman` (roman); error =
  `{ ok: false, error, message, detail, provider, serving_mode, model_scale, note: "controlled error - the request was NOT silently rerouted to another provider" }`.

## 3. Browser recording → transcript → draft flow (16 kHz PCM WAV is a HARD contract)

The service answers an honest **400** for anything that is not 16 kHz; it never silently
resamples. So the BROWSER delivers exactly 16 kHz mono PCM WAV:

1. Capture mono: `getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })`.
2. Preferred path: `new AudioContext({ sampleRate: 16000 })` + an `AudioWorklet` collecting
   Float32 samples while recording, then an in-page 16-bit PCM WAV encoder (44-byte header,
   little-endian, PCM s16le, mono). Fallback for browsers that ignore a forced 16 kHz context:
   record at the device rate, resample with `new OfflineAudioContext(1, durationFrames, 16000)`
   before encoding — resampling lives CLIENT-side; the server contract stays untouched.
3. `POST` the WAV blob as multipart to `/api/voxsoap/transcribe`
   (`files={"audio": ...}` equivalent: field name `audio`).
4. Render the envelope badges verbatim in the transcript card: `provider`, `serving_mode`,
   `model_scale`, `latency_s`; keep the transcript **editable by the clinician** before drafting.
5. `POST /api/voxsoap/draft { transcript }` → render the SOAP draft plus the deterministic
   `guard` annotations as UI badges (NOT verdicts — show `guard.review_hint`):
   - `schema.complete_schema` + `sections_present{SUBJECTIVE,OBJECTIVE,ASSESSMENT,PLAN}`
   - `facts.unsupported_numbers_in_draft` / `unsupported_med_tokens_in_draft`
   - `numbers_from_source_missing_in_draft` / `med_tokens_from_source_missing_in_draft`
   - `unstated_markers_used_in_draft`
6. Draft is editable; save per the app's existing consult schema (the ML service is stateless).
7. Session end / memory control: `POST /api/voxsoap/unload` `{"component":"all"}` frees the
   ~6 GB (CUDA) or ~12-13 GB (CPU fp32) SOAP footprint; the UI shows the unload state.
8. `/roman`: visually disabled with an honest 501/DEPRECATED tooltip. `provider:"gemini"`
   offers NO hidden path anywhere in the UI; failure drills must show the controlled error
   envelope (`note` field) — e.g. stop the Python service and confirm the proxy surfaces
   the failure without any Gemini substitute.

**UI copy honesty rules** (from the contract): never claim production readiness; call drafts
"assistive, vet-confirmation mandatory"; show `model_scale` everywhere a model result is shown.

## 4. Phase 5 acceptance checklist

- [ ] Local 64-bit service installed + auto-starts; `/health` shows FULL/FULL after login.
- [ ] One complete E2E consult loop through the REAL local service: mic → 16 kHz WAV → transcript
      (envelope badges visible) → editable transcript → draft (guard badges visible) → clinician
      edit → saved consult.
- [ ] Honest-failure drill: service stopped mid-session → the UI shows the controlled 5xx envelope,
      no Gemini rendering.
- [ ] `/unload` drill after the loop: process RAM returns ~ to pre-load.
- [ ] Vet review sheet workflow remains external (CSV from the Phase-3 artifacts).
- [ ] Environments documented (`.env.local` entries; no secrets needed — localhost only).

## 5. Open items carried forward

- Veterinary benchmark + review scoring (clinical gate, external to code).
- Model C/Roman permanently 501 unless owner re-enables with a passing adapter (deprecation record:
  `ml-training/reports/model_c_deprecation_20261029.md`).
- Long-clip ASR windowing, clinician-preserve-terms, auth — later scaffold hardening, out of P5 core.

## 6. Implementation status (2026-10-30) — CODE LANDED, live E2E pending the service

Committed on `Speech-to-Text-feature/voxsoap-model-integration`:

| Piece | File | Notes |
|---|---|---|
| Passthrough proxy | `src/app/api/voxsoap/[route]/route.ts` | nodejs runtime, route allowlist (GET: health; POST: transcribe/draft/roman/unload), byte-for-byte body passthrough, verbatim status+response, 300 s budget (`VOXSOAP_TIMEOUT_MS`), FR-6 receptionist 403 on transcribe/draft (parity with `/api/clinic/vox-soap/extract`), controlled 502/504 envelopes that explicitly say "NOT a model answer; nothing was rerouted to Gemini". Never synthesizes success. |
| Envelope contract types | `src/lib/vox-soap/voxsoap-ml.types.ts` | Flask envelope mirrored verbatim; `model_scale` typed as string OR map (health carries the map); `VoxSoapMLGuard` mirrors `guards.py` exactly. |
| ML client | `src/lib/vox-soap/voxsoap-ml.client.ts` | health/transcribe/draft/unload helpers; staff headers forwarded for provenance; non-envelope responses surfaced as honest `unparseable_response`; no throw-and-hide. |
| 16 kHz capture + WAV encoder | `src/lib/vox-soap/voxsoap-ml.wav.ts` + `public/worklets/pcm-recorder.js` | forced-16 kHz AudioContext + AudioWorklet Float32 capture; OfflineAudioContext CLIENT-side resample fallback for engines ignoring forced rates; canonical 44-byte s16le mono WAV encoder. Server stays resample-free. |
| UI panel | `src/components/vox-soap/MLAssistPanel.tsx` | health precheck → consent → record (pause/resume, 12-min/23 MB guard under the 25 MB server cap) → encode → transcribe → EDITABLE transcript (14 000-char server cap surfaced) → draft → EDITABLE draft + deterministic guard badges (`complete_schema`, per-section ✓/✗, unsupported/omitted fact chips, unstated markers, `review_hint` verbatim) → envelope badges (provider/serving_mode/model_scale/latency_s) on every output; `/roman` disabled with the DEPRECATED-501 truth; `/unload` button shows `unload_status` + `model_scale_after`; mock-provider warning chip when `providers.ml.is_mock`. |
| Workspace entry | `src/components/vox-soap/VoxSoapWorkspace.tsx` | "🧠 ML Assistive Draft" buttons added to both capture CTA rows and the panel mounted alongside the existing Gemini panels — the Gemini flow is untouched and clearly separate. |
| Env | `.env.local` (gitignored) | `VOXSOAP_BASE_URL=http://127.0.0.1:8321` (matches the proxy fallback). |

Verification done so far (tsc clean, eslint clean):
- **Proxy honest-failure drills against the dev server (ML service intentionally down):** GET
  `/api/voxsoap/health` → controlled 502 `service_unreachable` envelope; GET on a POST route → 404
  `unknown_route`; POST `/draft` as receptionist → 403 FR-6 (no upstream call); POST `/draft` as vet →
  controlled 502 envelope; POST bogus route → 404. No path renders a Gemini-style success.
- **WAV encoder byte-level checks (mirrored harness, all PASS):** canonical RIFF/WAVE/fmt/data tags,
  PCM=1, mono, 16000 Hz, byte rate 32000, block align 2, 16 bits, data sizes, boundary conversions
  (0→0, 0.5→16383, −0.5→−16384, 1.0→32767, −1.0→−32768, clamp ±1), header-only empty blob.

Still open (same acceptance checklist, §4): start the REAL local service (§1 venv) and run the full
E2E loop — recording needs a live mic in a logged-in clinic session, and the visual pass needs a real
`/health` + `/transcribe` + `/draft` through `127.0.0.1:8321`. Until then the panel shows the honest
"service not running" drill state by design.

## 7. Local venv + live service gate (2026-10-30) — SUBSET PASSED, E2E with the owner still open

64-bit Python **3.12.10** venv installed at `.venv-ml64/` (gitignored), stack EXACTLY as pinned in
`requirements-serving-ml.txt`: torch **2.11.0+cpu**, transformers **4.48.3**, peft 0.18.1,
accelerate 1.3.0, soundfile 0.13.1, bitsandbytes 0.49.2 (installed; unused by the serving compute
path — the 4-bit loader stays Linux/Colab-only), numpy 2.5.4.

- **Mocked contract suite in the venv:** 24 passed / 4 deselected (7.27 s).
- **Real-marker suite in the venv (first LOCAL real-inference run of the gate tests):**
  `test_real_health_reports_unloaded_real_components` PASSED ·
  `test_real_transcribe_with_phase2_adapter` PASSED (real Whisper-small + the FULL Urdu LoRA, fp32
  CPU on this machine) · `test_real_roman_stays_501_until_model_c_lands` PASSED ·
  `test_real_draft_with_fullscale_adapter` SKIPPED with its honest reason (fp32 3B ≈ 12–13 GB RAM on
  a 15.9 GB machine — the skip-guard is the Windows safeguard working). 3 passed / 1 skipped /
  24 deselected in 959.70 s.
- **Live service:** uvicorn (app:app, 127.0.0.1:8321) on the venv; `GET /health` → 200 with
  `asr: FULL` + `soap: FULL` (`training_manifest.model_scale`), `roman: UNKNOWN(no
  training_manifest.json)`, `providers.ml.is_mock: false`, gemini `proxy_url_set: false`.
- **Live `/transcribe` probe:** 200 — `serving_mode: "real-provider"`, `model_scale: "FULL"`,
  honest envelope fields + audio echo block (16 kHz / 48 000 samples decoded). Probe audio was a
  SYNTHETIC 3 s tone WAV: the transcription text is meaningless by design and repeated a single
  Urdu token (Whisper loop behaviour on non-speech input) — that probe gated the ENVELOPE and the
  real fp32 CPU inference path, not transcription quality. Real-consultation quality evidence
  remains the Phase-3 gates + vet review sheet, as before.
- `/draft` deliberately NOT probed from the agent shell: the 3B fp32 load (~12–13 GB against a
  15.9 GB machine) is best done exactly once from the owner's E2E session, with other apps closed
  (and the first load performs the one-time Qwen2.5-3B hub download ~6 GB, cached in
  `%USERPROFILE%\.cache\huggingface`). Loading, answering and unloading from the browser drill
  remains the acceptance step (§4).

## 8. Local speed + RAM fixes (2026-10-31, owner-requested) — lgtm pending owner CPU run

Owner pain: first `/draft` from the UI burned the 300 s proxy ceiling on the under-way hub download
and a ~12.4 GB fp32 3B load against ~3.7–6 GB free RAM; both are capacity, not correctness,
problems and were fixed as capacity problems — never by hiding the failure.

- **Weights pre-cached:** full `Qwen/Qwen2.5-3B-Instruct` snapshot resolved through
  `huggingface_hub.snapshot_download` in `.venv-ml64` BEFORE any UI click (resumed from the
  2.48 GB partial cache). `hf_xet` deliberately NOT installed — the venv stays byte-exact to the
  pinned requirements.
- **SOAP dtype:** `_load_soap` now picks bfloat16 on CPU (fp16 stays the CUDA auto), halving the
  3B CPU footprint ~12.4 GB → ~6.2 GB, faster oneDNN matmuls, `low_cpu_mem_usage=True` streams the
  weights in. Honest escape hatch: `VOXSOAP_SOAP_DTYPE=bfloat16|float16|float32` overrides the
  auto; roman/mt5 keeps its fp32 master (direct-fp16 NaN guard note unaffected — Qwen is a causal
  LM, not T5-family). ASR stays fp32 → the verified eval recipe is untouched; its fp32 footprint
  is small. HONESTY CAVEAT: bf16 CPU is a numerical change vs the fp32 measured eval — the vet
  review sheet remains the clinical verdict source (unchanged rule).
- **Draft token budget:** `/draft` accepts an optional `max_new_tokens` (1..512, out-of-range =
  honest 400 before any model work) and the provider defaults to **256 on CPU** (512 stays for
  CUDA). The envelope echoes the effective cap. Mocked suite 31 → **33** (override-forwarded +
  out-of-range cases); the fakes record the override in `calls[2]`.
- **Proxy budget:** `/api/voxsoap/*` timeout 300 s → **900 s** (`VOXSOAP_TIMEOUT_MS` still wins if
  set); the page client sits at 912 s so the proxy's controlled 504 still wins the race.
- **Ops aids:** `start-voxsoap-local.bat` (two-window launcher), `ml-serving/probe_local_service.mjs`
  (health → 35 s EN 2-window transcribe → klingon-400 → `/unload all`), README counts refreshed.
- Live re-gate after the restart (agent-visible tail): probe chain passed — health → real 35 s EN
  `/transcribe` (200, real-provider FULL, ASR loaded by the run itself) → `klingon` honest-400 →
  `/unload all` with `asr: true` dropped (soap/roman were never loaded) and RAM visibly returned.
  (Owner's first live bf16 CPU
  `/draft` still lands as their acceptance evidence.)

## 9. Local-first frontend audio routing (2026-10-31, critical routing bug) — drill 13/13

Owner symptom: BOTH legacy capture panels (UploadAudioPanel with a 5-min WebM file and
NewRecordingPanel with 24 s/29 s live recordings) surfaced
`AI TRANSCRIPTION FAILED — NOTHING WAS INVENTED` plus
`GEMINI_API_KEY is not configured; switching to deterministic fallback parser...` during local ML
development. Audit located the cause: ALL Gemini coupling lives in `vox-soap.engine.ts` (the
panels are provider-agnostic) and the engine's single multimodal Gemini call did the
transcription AND structuring — with no key it degraded into the deterministic parser while
complaining about the missing key.

The fix is ENGINE-LEVEL, never a panel bolt-on, and reverses the fallback direction:

- **`resolveTranscribeProvider()`** (engine): explicit input override → env
  `VOXSOAP_TRANSCRIBE_PROVIDER` → default **`ml`**. Gemini transcription is now an EXPLICIT
  opt-in transport; `ml` mode NEVER touches or mentions Gemini. Bad values throw honest errors
  (route answers 400 before any model work).
- **`mlTranscribe()`** (engine): POSTs the audio STRAIGHT to the local ml-serving FastAPI
  (`VOXSOAP_BASE_URL`, default `http://127.0.0.1:8321/transcribe`) with the same multipart
  contract the committed probe exercises (field `audio`, `language`); 900 s budget
  (`VOXSOAP_ML_TRANSCRIBE_TIMEOUT_MS`). Failures are THROWN honestly into the existing catch
  (`aiError` audited, `Manual_Fallback_Draft` template) — never rerouted to Gemini in EITHER
  direction.
- **New honest label `ML_Local_Draft`** (types union + audit action
  `ML_LOCAL_TRANSCRIPTION_DRAFT` + metadata `transcriptionProvider` / `asrLanguage` /
  `transcriptionWindows`). The transcript is REAL and preserved verbatim; SOAP structuring is
  deliberately left to the deterministic template + vet review (grounding-claim filter stays
  `AI_Dictation_Draft`-only because the template's claims are traceable by construction).
  Audit-trail discipline: exactly ONE extraction event per run (no duplicate-emit).
- **Panels deliver the ml audio contract CLIENT-side** (the server never resamples):
  - `NewRecordingPanel`: MediaRecorder is GONE — the shared
    `startPcm16Capture` AudioWorklet captures 16 kHz mono PCM directly; pause/resume drop
    frames worklet-level; stop() encodes the canonical WAV; the size pill reads the REAL
    deliverable (`pcm16kBytesForSeconds` × 32,000 B/s). Posts `consultation-16k.wav` +
    `language` + `transcribeProvider` (gemini pacing pinned via
    `NEXT_PUBLIC_VOXSOAP_TRANSCRIBE_PROVIDER`).
  - `UploadAudioPanel`: unless the public env pins `gemini`, the file is decoded +
    resampled CLIENT-side via `decodeAndResampleToWav16k` per attempt (idempotent — retries
    re-read the original File), with honest pre-upload guards: encoded WAV > 25 MB and > 13 min
    (`pcm16kSecondsForBytes`) are rejected BEFORE anything is sent.
  - Both panels gained the `language` select (default `ur`, mirroring MLAssistPanel), passed
    as form field `language`; `WritingAssistant` (Gemini rewriter) deliberately untouched —
    its key error is a different feature, not audio processing.
- **`/extract` route pre-flights** (all BEFORE any model work): honest 400 for unknown
  `language` (allowed `ur | en | auto`) and unknown `transcribeProvider` (allowed `ml |
  gemini`); honest **415** when the resolved provider is ml and the audio base MIME ≠
  `audio/wav` (message states the client-side WAV contract + server-never-resamples rule).
  Text-only JSON requests are deliberately UNCHANGED (outside the audio mandate; honest
  fallback preserved).
- **Drill evidence** (next dev + uvicorn 8321, synthetic 35 s 16 kHz WAV / language=en):
  `probe_local_extract.mjs` → **13/13** — 201 with `sourceType=ML_Local_Draft`,
  `rawTranscript` non-empty, `NO gemini/i mention` in the response AND the visit audit trail,
  audit event `ML_LOCAL_TRANSCRIPTION_DRAFT` with `transcriptionProvider=ml`,
  `asrLanguage=en`, `aiModel=voxsoap-local-ml:whisper(language=en)`, fake-WebM → 415,
  `klingon` → 400, `openai` → 400, text-only path still answers (honest fallback). tsc 0,
  eslint 0 on all five touched files.
- Honest caveat: synthetic tone is not real speech — the gated property is ROUTING honesty;
  the owner's 5-min English upload + 24-29 s Urdu mic recordings are the content acceptance.

## 10. Owner 4-fix delivery (2026-11-01/03) — all coded, mocked 48/48, live contracts green

Branch `Speech-to-Text-feature/voxsoap-model-integration`. Everything below is MOCKED-test
verified (33 → **48 passed**, 4 real deselected) AND the live parts were re-gated against the
real bf16 CPU service on this machine after each hardening pass. Three proto-fix verdicts were
superseded by the final one — the supersessions are part of the record.

### Fix 1 — ASR English cutoff/speed (`providers.py::transcribe`, `_load_asr`)

- Root cause: the ur-LoRA adapter was trained on FLEURS clips (short single sentences padded to
  30 s), so dense continuous English dialogue triggered an early EOS. English (`language=en`)
  now decodes with the UNCORRUPTED base `openai/whisper-small` weights
  (`model.disable_adapter()` around `generate`); Urdu keeps the adapter; `auto` keeps it too
  (documented: explicit `en` is the escape hatch).
- Speed/robustness: 30 s windows → sequential **20 s chunks** (320,000 samples, no overlap,
  boundary-clip honesty in `note`); silent chunks skipped (max |sample| < 1e-3, skipped count
  reported); `condition_on_prev_tokens=False` so no cross-chunk conditioning; CPU always
  `torch.set_num_threads(cpu_count)`; `VOXSOAP_ASR_QUANT=1` enables dynamic qint8 quantization
  as an explicit OPT-IN (default OFF: PEFT/qint8 interaction + eval-parity risk).
- Live evidence (before the env restart): 35 s EN probe → `windows: 2`,
  note "multi-chunk transcription: 2 x 20 s chunks joined (no overlap; 0 silent chunk(s)
  skipped)", latency 75.9 s, `language=klingon` honest 400, `/unload` hygiene RAM drop.

### Fix 2 — `/draft` default `vet_scribenote` (`providers.py` + `app.py`)

- New constants: `VET_NOTE_FORMAT(S)`, 23-parameter `VET_OBJECTIVE_PARAMS` (exact owner order,
  never re-sorted), strict `VET_SCRIBENOTE_SYSTEM_PROMPT` (four mandated headings; only
  transcript-stated parameters; placeholders FORBIDDEN), canonical-key alias lookup
  (temp/hr/bw/rr/crt/fast/ears/otoscopy/…, case/punctuation-insensitive).
- `draft(..., note_format)`: `vet_scribenote` = BASE Qwen (`disable_adapter()`), CPU cap 448
  (medscribe keeps the legacy 256; both ≤ the 512 configured cap; request-level override still
  wins and is echoed). Post-processing (`_vet_split_sections` → `_vet_parse_objective` →
  `_vet_normalize_bullets` → `_vet_hydrated_story`) deterministically hydrates ALL 23
  parameters (missing → `Not mentioned`) and the envelope carries `draft` +
  `sections{subjective, objective_map, objective_text, assessment, plan}`. `medscribe` keeps
  the EXACT legacy behaviour. Unknown `format` = honest 400 BEFORE model work; `clinical_guard`
  still annotates every draft.
- **Hardening pass 1 (live finding):** the base-3B model filled unstated parameters with
  "not examined"/"Normal"-style placeholders (stated 13/23). Prompt hardened to forbid them
  explicitly; deterministic `_vet_value_or_not_mentioned()` collapses bare non-data tokens
  ("Normal", "WNL", "N/A", "unremarkable", "none", …) into the canonical `Not mentioned` fill —
  mirrored in `src/lib/vox-soap/vox-soap.vetnote.ts` (`isVetPlaceholderValue`, same token set)
  so client-side Apply mapping never disagrees.
- **Hardening pass 2 (live finding):** stated values whose tokens could not trace to the
  transcript ("pink and moist" vitals) — the trace gate drops any stated value with no
  verbatim token trace in the consultation transcript into `Not mentioned` + counts it in the
  envelope note ("drop-never-rewrite", mirroring the frontend FR-27 claim filter). Units are
  stopwords so real spoken data ("24.5 kg") survives. Gate is inert without a transcript
  (pure unit path) and tested both ways.
- `GeminiProxyProvider.draft` accepts the same kwarg (forwards `format` upstream; the 501
  honesty test still passes with the real provider class).

### Fix 3 — frontend wiring (`vox-soap.engine.ts`, new `vox-soap.vetnote.ts`, panels)

- Engine ml branch now: `mlTranscribe()` → stash `mlLocalTranscript` verbatim →
  `mlLocalDraft()` → `groundedFromVetSections()` → `sourceType='ML_Local_Draft'` with audit
  model `voxsoap-local-ml:whisper(language=X)→qwen-draft(vet_scribenote)`. `mlLocalDraft`
  POSTs `{transcript, format:'vet_scribenote'}` to the local service with the honest 900 s
  budget (`VOXSOAP_ML_DRAFT_TIMEOUT_MS`) and validates the `sections` boundary (missing
  sections = thrown error, never a silently empty card). On ANY failure the catch keeps the
  FULL stashed transcript in the deterministic fallback template.
- **Truncation removed everywhere:** `buildManualFallbackTemplate` no longer slices
  (the old 160/120-char cuts produced the owner's mid-word quote); presenting complaint and
  source quote carry the full verbatim transcript.
- New deterministic TS mapper `vox-soap.vetnote.ts` (shared canonical rules with the server:
  23-param order, aliases, placeholder collapse, "Not mentioned"→null, bullet
  classification into vaccinations/med orders/tests/follow-up/general care, plan-dose parsing
  to medication-order fields) — TWO honest entry points: `groundedFromVetSections` (engine,
  envelope sections) and `groundedFromVetNoteText` (panel Apply, formatted text parse with the
  unknown-objective-lines surfaced, never dropped).
- "📋 Apply Draft to SOAP Workspace" button in `MLAssistPanel` (visible when the host passes
  `onApplyDraft`) → `VoxSoapWorkspace.handleApplyMlAssistDraft`: client-side patch of the four
  cards with the same mapping the server post-processing uses; applied med orders carry honest
  `UNKNOWN` validation and `canConfirmOrder:false` (the client never fabricates a MATCH
  badge); the record stays a Draft; `groundingAuditNote` gains an assistive-source marker +
  any unrecognized objective lines; visit stays Draft; vet confirmation remains mandatory.

### Fix 4 — Leo ear-infection verification

- MOCKED (deterministic, `tests/test_vet_scribenote_contract.py`, gates the REAL post-processing
  functions fed the live model's output shape): 15 checks — 23-param EXACT order, Leo
  subjective/objective/assessment/plan content gates, hydration, placeholder collapse, trace
  drop + inert path, no-heading fallback, continuation lines, format routing contract (default
  echo, medscribe forwarding, klingon → 400). Total mocked suite **46 → 48 passed**.
- LIVE (`ml-serving/probe_vet_draft.mjs`, raw-socket POST — undici's fixed 300 s headersTimeout
  kills minutes-long drafts with UND_ERR_HEADERS_TIMEOUT, so `fetch` cannot carry the probe):
  **CONTRACT 15/15** — HTTP 200 envelope badges + guard; `format:"vet_scribenote"` echoed;
  exactly the five sections; objective_map = EXACTLY the 23 canonical params in EXACT owner
  order; **Weight = "24.5 kg"** (the spoken value) and Ears populated ("Right ear canal red and
  inflamed, left ear clean and normal"); all 23 hydrated lines rendered in the draft; plus
  client-side re-verification that EVERY stated value's tokens trace verbatim into the Leo
  transcript (no fabrication possible in the envelope).
- Live content WARN inventory (assistive draft; owner-gated acceptance): 5/23 stated vs the
  checklist's 21 — Weight + Ears are the transcript-backed exam findings; the remaining trace
  gates survived as short over-attributions: Hydration Status="Good" and Eyes="Clear"
  (vocabulary-only attributions the trace window cannot disambiguate from an exam statement;
  vet deletes at review), Integument=COPY of the Ears value (3B filler artefact). Subjective
  drifts: "12-month-old" vs the spoken 3.5 years; "One month ago" vs 3 days; Apoquel/history
  phrasing varies; plan omits the ear-cleaner suggestion on some runs. These are the documented
  WARNs from content 6/11; the deterministic contract carries none of them.

### Live latency + environment honesty

- Cold measured `/draft` (bf16 Qwen load + generation, each probe after a clean
  uvicorn restart): **989.1 s / 1132.1 s / 1011.2 s**. The 900 s budgets
  (`ML_DRAFT_TIMEOUT_MS`, `/api/voxsoap/*` proxy ceiling) therefore abort a COLD first draft —
  the engine answer is the honest fallback template (transcript preserved verbatim), never a
  fabricated note. Documented mitigations: warm the service once with any `/draft` before the
  first real session, or raise `VOXSOAP_ML_DRAFT_TIMEOUT_MS`/`VOXSOAP_TIMEOUT_MS`. Warm
  generate-only latency was not measured (every probe cycle restarted the service per the
  concurrency rule) — recorded as an unknown rather than a guess.
- Concurrency hazard PROVEN this session: aborted/killed draft clients leave the server thread
  generating → zombie uvicorn stack → 1.4 GB free RAM page-thrash; the only safe procedure is:
  kill parent+worker uvicorn PIDs, relaunch, probe EXACTLY once. All live probes ran as
  single-shot raw sockets with full 1500-2400 s budgets (never concurrent, never aborted
  mid-flight).
- Environment exception: `hf_xet` UNINSTALLED in `.venv-ml64` (its import crashed the pinned
  `huggingface_hub 0.36.2` — the 12/12-file, ~5,897 MB Qwen snapshot completed cleanly after
  removal). pip would reinstall it on future hub upgrades; flagged here so the exception is
  not silently resurrected.
- E2E routing re-drill (post-Fix-3 engine): `probe_local_extract.mjs` (raw-socket multipart +
  chunked-response dechunking; the sync `/extract` chain outruns undici's headersTimeout too)
  → **10/10**: 201 with `sourceType=Manual_Fallback_Draft` (synthetic tone → Whisper returns no
  speech → the honest fallback keeps the transcript-stash path: nothing invented, nothing
  rerouted), `AI_FALLBACK_TRIGGERED` audited with `transcriptionProvider=ml`, fake-WebM → 415,
  `language=klingon` → 400, `transcribeProvider=openai` → 400, text-only path unchanged, and
  NO `/gemini/i` mention anywhere on audio paths. (§9's drill counted 13 assertions on the
  pre-Fix-3 version; the current harness totals 10 and all pass.)
- tsc 0 / eslint 0 across every touched frontend file at final gate; py_compile clean.

### Remaining (owner-visible)

- Vet review of ONE real consultation through the UI (mic panel → Apply Draft → confirm/Mark
  as Done) remains the human acceptance evidence — the code contract above is complete.
- The live content WARNs (over-attribution + subjective drifts) iterate only with a bigger
  scribe model or few-shot prompt tuning; the deterministic contract (order/ordering/no
  fabrication) is enforced server-side regardless.

## 11. Owner connectivity/UX batch (2026-11-04) — provider-aware failure UI, 2 s health
pre-check, node:http transport, per-chunk CPU hygiene

Triggered by the owner's real-usage report: a 5-minute Leo consultation under `PUBLIC_TRANSCRIBE_PROVIDER=ml`
surfaced the GEMINI retry copy ("every key and model candidate… brief demand spikes on Google's
side") on a local-ML failure — dishonest copy on an honest fallback.

- **Provider-aware failure banners** (`UploadAudioPanel.tsx`, `NewRecordingPanel.tsx`): the
  `stage === 'failed'` block now branches — local-ML deployments (default, or any error text
  matching `/Local ML|127\.0\.0\.1:8321/i`) get the exact `lastAiError` verbatim plus the true
  remediation ("Make sure the local ML service is running at http://127.0.0.1:8321 (run
  `start-voxsoap-local.bat`). Check the ML console for crashes or memory errors, then press ↻
  Retry transcription."), with ZERO Google/API-key/demand-spike mention; the Gemini candidate/
  demand-spike copy survives ONLY for an explicitly gemini-pinned deployment. The FR-30
  escape hatch stays available in BOTH branches (NewRecordingPanel).
- **aierrors cap 180 → 320** (`vox-soap.aierrors.ts`): the actionable remediation tail was being
  cut mid-word at 180 chars ("and retry i…"), hiding the instructions it exists to show.
- **Engine /health pre-check** (`assertLocalServiceHealthy`): a 2 s `AbortSignal.timeout(2000)`
  health GET before ANY multi-megabyte POST — a dead/crashed/OOM service now surfaces in ~2 s
  with the acceptance wording (`…could not be reached. Restart both windows
  (start-voxsoap-local.bat) and retry… (engine pre-check code=ECONNREFUSED)`) instead of wasting
  the transcription budget. The unhealthy-HTTP case re-raises verbatim through its catch via the
  "Local ML service answered HTTP" sentinel.
- **Engine transport migration (live-drill-driven)**: the 5-min drill caught the REAL root cause
  of long-run failures — undici's fixed 300 s `headersTimeout` killed the engine's `fetch` to
  `/draft` at exactly 300 s (`code=UND_ERR_HEADERS_TIMEOUT`); `AbortSignal.timeout` cannot raise
  that cap. BOTH long local calls now ride `node:http` (`postMultipartLocal` for the WAV,
  `postJsonLocal` for `/draft`; `connection: 'close'`, budget enforced via
  `req.setTimeout(budgetMs)` which destroys the request with a `TIMEOUT_BUDGET_<N>s` sentinel —
  classification: flat `.code` first (node:http errors carry ECONNREFUSED directly), nested
  `.cause?.code`, and the `TIMEOUT_BUDGET_` sentinel → honest processing-timeout wording).
  The 2 s /health pre-check stays on fetch (it answers long before any header cap).
- **POST-migration live proof** (5-min synthetic 220 Hz tone, service FULL/FULL): HTTP 201 in
  **626.3 s** with `sourceType=ML_Local_Draft` — the full `/transcribe` + `/draft` chain
  SUSTAINED 626 s through the transport that undici had capped at 300 s; audit event
  `ML_LOCAL_TRANSCRIPTION_DRAFT` recorded `transcriptionWindows=15`, `aiModel=
  voxsoap-local-ml:whisper(language=en)→qwen-draft(vet_scribenote)`, `aiError: null`, and the
  visit mapped STRUCTURED SOAP sections (23-parameter objective, source-quoted diagnoses, a
  validated 0.85-confidence fluid order) from Whisper's honest "Music Music…" hallucination of
  the non-speech tone — nothing invented, structure only. This also answers §10's open
  warm-latency question: a WARM (second-call) Qwen draft completes in ~450-470 s, INSIDE the
  900 s `ML_DRAFT_TIMEOUT_MS`; the 989-1132 s cold-load measurements stand, so pre-warm the
  service once after a restart before the first real session.
- **Per-chunk crash-proofing + CPU memory hygiene** (`providers.py::transcribe`): each 20 s
  chunk decode can no longer take the uvicorn worker down — an unexpected per-chunk failure is
  re-raised as a CONTROLLED `InferenceError` naming `[start:end]`, the sample count and the
  chunk index (→ `ok:false, error:'inference_error'`, HTTP 503 via app.py's ProviderError
  handler), and on CPU every finished chunk releases its tensors (`del chunk`, `gc.collect()`,
  wrapped so cleanup arithmetic can never break inference) and `_decode_window` releases
  `feats`/`ids` before returning — a 13-minute consult keeps a flat resident profile.
- **Lint scope fix** (`eslint.config.mjs`): `npm run lint` (`eslint`, bare) was scanning
  `.venv-ml64`'s vendored torch browser bundles (72 untrue findings incl. 1 error); the venv is
  now ignored so the gate measures project sources (0/0 across all four touched TS files).
- **Final gates**: py_compile 0; pytest mocked `-m "not real"` **48 passed**; `tsc --noEmit` 0;
  per-file eslint 0; **`npm run lint` 0**. Live drills: service-DOWN **8/8** (banner wording,
  1.8-2.5 s ToF, zero Google wording in response AND banner); 5-min UP **9/9 effective** (the
  single "FAIL" during the session was the probe reading the note from the wrong payload path —
  corrected; the structured-section evidence above is from the stored visit itself).
