This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## VoxSOAP ML serving (Phase 5)

The veterinary SOAP dictation feature runs inference **locally** through a
FastAPI service in `ml-serving/` (`uvicorn app:app --host 127.0.0.1 --port 8321`).
The Next.js proxy `/api/voxsoap/*` is the only client; there is **no silent
Gemini fallback** — every ML failure is a controlled, labeled envelope.

### Draft backends (owner box: CPU-only i5-6300U, 16 GB RAM)

| Backend | When | Notes |
|---|---|---|
| `gguf` | default `auto` on CPU for `format=vet_scribenote` | Quantized `Qwen2.5-1.5B-Instruct Q4_K_M` via `llama-cpp-python` (auto-discovered from `ml-serving/models/`); cold load ~3.7 s, full 5-min consult draft in ~1.8 min, peak RSS ~1.76 GB (`qwen2.5-3b-instruct-q4_k_m.gguf` also pre-cached for faster CPUs) |
| `torch` | `auto` on CUDA, explicit `VOXSOAP_SOAP_BACKEND=torch`, or the legacy `format=medscribe` path | The original bf16 base + PEFT adapter stack (slow on CPU: cold load 8-19 min) |

`VOXSOAP_SOAP_BACKEND=auto|gguf|torch` selects the policy; `gguf` without
`llama_cpp` installed is an honest 503 (never a silent swap). A quantized GGUF
is **never** labeled as the unquantized PEFT adapter — envelopes carry
`backend` + `gguf_model` + an accurate `model_scale`
(`FULL-BASE-GGUF(...LoRA adapter NOT applied...)`).

### Async draft jobs (recommended by the panel)

A multi-minute CPU decode must not live inside a proxy socket budget, so the
panel uses three job routes:

```text
POST /api/voxsoap/draft/start              -> 202 { job_id, status: "queued", ... }
GET  /api/voxsoap/draft/status/<job_id>    -> pure in-memory snapshot (<10 ms)
POST /api/voxsoap/draft/cancel/<job_id>    -> per-token cancel Event
```

Statuses: `queued | loading_model | generating | completed | failed | cancelled`
plus `tokens_generated / max_new_tokens / elapsed_s`; `completed` carries the
full `/draft` envelope. Concurrent starts (and the synchronous `POST /draft`)
share one single-flight lock and answer an honest **409 `draft_busy`**.
Cancellation is checked every token, so the worker exits immediately instead
of leaving a zombie CPU decode. Jobs are in-memory: **a service restart clears
them** (the panel re-starts cleanly).

The legacy synchronous `POST /draft` remains fully supported.

### Model download (this network only)

HuggingFace's CDN throttled to ~0.03 MB/s with mid-stream drops here, while
the Ollama registry served the same Qwen2.5 weights at ~0.8 MB/s. Fetch and
verify the GGUF blob with:

```powershell
.venv-ml64\Scripts\python.exe ml-serving\scripts\fetch_gguf_blob.py `
  --url https://registry.ollama.ai/v2/library/qwen2.5/blobs/sha256:5ee4f07cdb9beadbbb293e85803c569b01bd37ed059d2715faa7bb405f31caa6 `
  --sha256 5ee4f07cdb9beadbbb293e85803c569b01bd37ed059d2715faa7bb405f31caa6 `
  --size 1929903008 `
  --out ml-serving\models\qwen2.5-3b-instruct-q4_k_m.gguf
```

Then point `VOXSOAP_SOAP_GGUF_PATH` at the file (or pre-download a HuggingFace
repo/file pair and rely on the `VOXSOAP_SOAP_GGUF_REPO` / `_FILE` cache
resolution). Real-hardware benchmark:
`ml-serving/scripts/bench_soap_gguf.py`; measured numbers and decisions are in
`ml-serving/reports/phase5_integration_plan.md` §14.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
