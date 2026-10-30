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
