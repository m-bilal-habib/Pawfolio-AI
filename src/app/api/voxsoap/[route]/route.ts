// File: d:\Pawfolio AI\src\app\api\voxsoap\[route]\route.ts
import http from 'node:http';
import { NextRequest, NextResponse } from 'next/server';
import { ClinicStaffRole } from '@/lib/vox-soap/vox-soap.types';

/**
 * Phase 5 passthrough proxy: `/api/voxsoap/[route]` → the local VoxSOAP ML
 * FastAPI service (VOXSOAP_BASE_URL, default http://127.0.0.1:8321). The ML
 * service is localhost-only; this proxy is the only client.
 *
 * Hard rules (feature contract + phase-4 gate):
 *   - PASSTHROUGH ONLY: the upstream status AND body come back verbatim
 *     (envelope, 400/422/501/503s included) — the UI renders the honest ML
 *     failure; this proxy MUST never synthesize a Gemini answer or upgrade
 *     a controlled error into a success.
 *   - Route allowlist mirrors the FastAPI surface exactly.
 *   - FR-6 parity with /api/clinic/vox-soap/extract: receptionists cannot
 *     initiate clinical SOAP dictation (/transcribe, /draft) → 403.
 *   - Node runtime: multipart audio uploads are byte-array passthrough.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BASE_URL = process.env.VOXSOAP_BASE_URL ?? 'http://127.0.0.1:8321';
/** Draft inference on CPU: bf16 3B + the 320-token cap keeps a warm draft
 * inside ~4-8 minutes on a calm box, but the FIRST draft after a cold load
 * (bf16 3B load + possible hub resume) measured 989-1,132 s, and under the
 * owner box's worst memory pressure a full warm draft reached ~1,100 s
 * (2026-11-05 drills) - the honest budget is 20 min, the failure is
 * communicated, never fabricated. */
const TIMEOUT_MS = Number(process.env.VOXSOAP_TIMEOUT_MS ?? 1_200_000);

const ALLOWED_GET = new Set(['health']);
const ALLOWED_POST = new Set(['transcribe', 'draft', 'roman', 'unload']);
const STAFF_PROTECTED_POST = new Set(['transcribe', 'draft']);

function staffRoleOf(req: NextRequest): ClinicStaffRole {
  const roleHeader = (req.headers.get('x-staff-role') ?? 'veterinarian') as ClinicStaffRole;
  return ['veterinarian', 'assistant', 'receptionist', 'admin'].includes(roleHeader)
    ? roleHeader
    : 'veterinarian';
}

function forwardStaffHeaders(req: NextRequest): Record<string, string> {
  const header = (name: string) => req.headers.get(name) ?? '';
  return {
    'x-staff-role': header('x-staff-role'),
    'x-staff-id': header('x-staff-id'),
    'x-staff-name': header('x-staff-name'),
    'x-clinic-id': header('x-clinic-id'),
  };
}

/** Proxy-caused (not ML-caused) failures keep the contract shape: controlled,
 * clearly labeled as passthrough errors, never a model answer. */
function proxyError(
  status: number,
  code: string,
  message: string
): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: code,
      message,
      provider: 'ml',
      serving_mode: null,
      model_scale: 'UNAVAILABLE(local VoxSOAP ML service not reached)',
      note:
        'controlled passthrough error at the Next.js proxy — NOT a model answer; nothing was rerouted to Gemini',
    },
    { status }
  );
}

async function passThrough(upstream: Response): Promise<NextResponse> {
  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    },
  });
}

/**
 * Owner proxy fix (2026-11-04): undici's global fetch enforces a FIXED 300 s
 * `headersTimeout` — a minutes-long local draft gets its socket killed with
 * `UND_ERR_HEADERS_TIMEOUT` (surfacing as an honest-but-wrong 502
 * `service_unreachable` around the 5-minute mark) and `AbortSignal.timeout`
 * CANNOT raise that cap. The long POST routes therefore ride `node:http`
 * (no headersTimeout), with the whole proxy budget enforced via
 * `req.setTimeout` and a sentinel `TIMEOUT_BUDGET_<N>s` error classified as
 * the honest 504 `upstream_timeout`; a connection refusal stays 502
 * `service_unreachable`.
 */
function postUpstream(
  urlString: string,
  headers: Record<string, string>,
  body: Buffer,
  budgetMs: number
): Promise<{ status: number; contentType: string | null; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const upstream = http.request(
      {
        host: url.hostname,
        port: Number(url.port || 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          ...headers,
          'content-length': String(body.length),
          connection: 'close',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', (resErr) => reject(resErr));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            contentType: res.headers['content-type'] ?? null,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    // CPU draft inference is SILENT until the final envelope, so socket
    // inactivity IS the honest budget — nothing beneath it can abort at 300 s.
    upstream.setTimeout(budgetMs, () => {
      upstream.destroy(new Error(`TIMEOUT_BUDGET_${Math.round(budgetMs / 1000)}s`));
    });
    upstream.on('error', (reqErr) => reject(reqErr));
    upstream.end(body);
  });
}

function describeUpstreamError(err: unknown): { status: number; code: string; message: string } {
  const name = err instanceof Error ? err.name : '';
  // The node:http budget sentinel and the fetch-era AbortSignal timeouts are
  // the SAME diagnosis (the budget elapsed while the model was busy) → 504;
  // every un-classified failure (ECONNREFUSED first) stays 502.
  const isBudgetTimeout =
    (err instanceof Error && /^TIMEOUT_BUDGET_/.test(err.message)) ||
    name === 'TimeoutError' ||
    name === 'AbortError';
  if (isBudgetTimeout) {
    return {
      status: 504,
      code: 'upstream_timeout',
      message:
        'The VoxSOAP ML service did not answer within the proxy budget — CPU draft inference can take minutes; retry or start the service.',
    };
  }
  const flatCode = (err as NodeJS.ErrnoException).code;
  return {
    status: 502,
    code: 'service_unreachable',
    message: `The local VoxSOAP ML service is not reachable at VOXSOAP_BASE_URL. Start it (uvicorn app:app --host 127.0.0.1 --port 8321, see ml-serving/reports/phase5_integration_plan.md §1) and retry. Nothing was invented.${
      typeof flatCode === 'string' ? ` (code=${flatCode})` : ''
    }`,
  };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ route: string }> }
): Promise<NextResponse> {
  const { route } = await params;
  if (!ALLOWED_GET.has(route)) {
    return proxyError(
      404,
      'unknown_route',
      `GET /api/voxsoap/${route} is not an ML service route (allowed GET: health).`
    );
  }
  try {
    const upstream = await fetch(`${BASE_URL}/${route}`, {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(Math.min(TIMEOUT_MS, 30_000)),
    });
    return await passThrough(upstream);
  } catch (err) {
    const { status, code, message } = describeUpstreamError(err);
    return proxyError(status, code, message);
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ route: string }> }
): Promise<NextResponse> {
  const { route } = await params;
  if (!ALLOWED_POST.has(route)) {
    return proxyError(
      404,
      'unknown_route',
      `POST /api/voxsoap/${route} is not an ML service route (allowed POST: transcribe, draft, roman, unload).`
    );
  }
  // FR-6 parity with /api/clinic/vox-soap/extract: initiating clinical SOAP
  // dictation (record/consultation audio → transcription → drafts) is a
  // veterinarian/assistant/admin action.
  if (STAFF_PROTECTED_POST.has(route) && staffRoleOf(req) === 'receptionist') {
    return NextResponse.json(
      { error: 'Forbidden (FR-6): Receptionists cannot initiate clinical SOAP dictation.' },
      { status: 403 }
    );
  }
  try {
    // Owner observability (2026-11-04): minutes-long CPU drafts are invisible
    // without a start anchor in the dev-server console — the drill evidence
    // (probe-side first-data + this line) explains any budget-timing anomaly
    // without guessing.
    console.info(
      `[voxsoap-proxy] POST /${route} → ${BASE_URL} (budget ${Math.round(TIMEOUT_MS / 1000)}s, body ${req.headers.get('content-length') ?? '?'}B)`
    );
    // Byte-for-byte passthrough (multipart boundary stays valid; JSON bodies
    // untouched). Size policy stays with the ML service (VOXSOAP_MAX_AUDIO_MB,
    // transcript_max_chars) — the proxy never invents its own limits.
    // Owner proxy fix (2026-11-04): undici's fetch aborts minutes-long POSTs
    // at its fixed 300 s headersTimeout — the body rides node:http instead
    // (same bytes, same headers) with the FULL proxy budget enforced.
    const answer = await postUpstream(
      `${BASE_URL}/${route}`,
      {
        'content-type': req.headers.get('content-type') ?? '',
        ...forwardStaffHeaders(req),
      },
      Buffer.from(await req.arrayBuffer()),
      TIMEOUT_MS
    );
    return new NextResponse(answer.body, {
      status: answer.status,
      headers: {
        'content-type': answer.contentType ?? 'application/json',
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    const { status, code, message } = describeUpstreamError(err);
    // Owner observability (2026-11-04): controlled failures must carry their
    // OS-level cause into the dev-server console, not only the browser
    // envelope (drill-B lesson: the classification was invisible server-side).
    console.warn(
      `[voxsoap-proxy] POST /${route} upstream failure → ${status} ${code}`,
      err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    );
    return proxyError(status, code, message);
  }
}
