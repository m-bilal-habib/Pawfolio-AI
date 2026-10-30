// File: d:\Pawfolio AI\src\app\api\voxsoap\[route]\route.ts
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
/** Draft inference on CPU can take minutes — the honest budget is generous,
 * the failure is communicated, never fabricated. */
const TIMEOUT_MS = Number(process.env.VOXSOAP_TIMEOUT_MS ?? 300_000);

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

function describeUpstreamError(err: unknown): { status: number; code: string; message: string } {
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return {
      status: 504,
      code: 'upstream_timeout',
      message:
        'The VoxSOAP ML service did not answer within the proxy budget — CPU draft inference can take minutes; retry or start the service.',
    };
  }
  return {
    status: 502,
    code: 'service_unreachable',
    message:
      'The local VoxSOAP ML service is not reachable at VOXSOAP_BASE_URL. Start it (uvicorn app:app --host 127.0.0.1 --port 8321, see ml-serving/reports/phase5_integration_plan.md §1) and retry. Nothing was invented.',
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
    // Byte-for-byte passthrough (multipart boundary stays valid; JSON bodies
    // untouched). Size policy stays with the ML service (VOXSOAP_MAX_AUDIO_MB,
    // transcript_max_chars) — the proxy never invents its own limits.
    const upstream = await fetch(`${BASE_URL}/${route}`, {
      method: 'POST',
      body: await req.arrayBuffer(),
      headers: {
        'content-type': req.headers.get('content-type') ?? '',
        ...forwardStaffHeaders(req),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return await passThrough(upstream);
  } catch (err) {
    const { status, code, message } = describeUpstreamError(err);
    return proxyError(status, code, message);
  }
}
