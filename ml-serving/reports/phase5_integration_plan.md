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
