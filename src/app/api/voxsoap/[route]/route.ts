// File: d:\Pawfolio AI\src\app\api\voxsoap\[route]\route.ts
import { NextRequest, NextResponse } from 'next/server';
import {
  VOXSOAP_BASE_URL,
  VOXSOAP_TIMEOUT_MS,
  answerToResponse,
  describeUpstreamError,
  forwardStaffHeaders,
  passThrough,
  proxyError,
  requestUpstream,
  staffRoleOf,
} from '../_lib/voxsoap-proxy';

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
 *   - The async draft job routes live in nested static folders
 *     (`draft/start`, `draft/status/[jobId]`, `draft/cancel/[jobId]`) and
 *     share the same helper module; static segments win over this `[route]`
 *     dynamic segment in Next.js routing.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_GET = new Set(['health']);
const ALLOWED_POST = new Set(['transcribe', 'draft', 'roman', 'unload']);
const STAFF_PROTECTED_POST = new Set(['transcribe', 'draft']);

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
    const upstream = await fetch(`${VOXSOAP_BASE_URL}/${route}`, {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(Math.min(VOXSOAP_TIMEOUT_MS, 30_000)),
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
      `[voxsoap-proxy] POST /${route} → ${VOXSOAP_BASE_URL} (budget ${Math.round(VOXSOAP_TIMEOUT_MS / 1000)}s, body ${req.headers.get('content-length') ?? '?'}B)`
    );
    // Byte-for-byte passthrough (multipart boundary stays valid; JSON bodies
    // untouched). Size policy stays with the ML service (VOXSOAP_MAX_AUDIO_MB,
    // transcript_max_chars) — the proxy never invents its own limits.
    // Owner proxy fix (2026-11-04): undici's fetch aborts minutes-long POSTs
    // at its fixed 300 s headersTimeout — the body rides node:http instead
    // (same bytes, same headers) with the FULL proxy budget enforced.
    const answer = await requestUpstream(`${VOXSOAP_BASE_URL}/${route}`, {
      method: 'POST',
      headers: {
        'content-type': req.headers.get('content-type') ?? '',
        ...forwardStaffHeaders(req),
      },
      body: Buffer.from(await req.arrayBuffer()),
      budgetMs: VOXSOAP_TIMEOUT_MS,
    });
    return answerToResponse(answer);
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
