// File: d:\Pawfolio AI\src\app\api\voxsoap\_lib\voxsoap-proxy.ts
import http from 'node:http';
import { NextRequest, NextResponse } from 'next/server';
import { ClinicStaffRole } from '@/lib/vox-soap/vox-soap.types';

/**
 * Shared helpers for the Phase 5 VoxSOAP ML passthrough proxy.
 *
 * The existing `/api/voxsoap/[route]` route and the newer nested async draft
 * routes (`/draft/start`, `/draft/status/[jobId]`, `/draft/cancel/[jobId]`)
 * MUST behave identically on the honesty boundaries:
 *   - passthrough only: upstream status + body come back verbatim;
 *   - FR-6 parity: receptionists cannot start/observe/control clinical SOAP
 *     draft jobs → 403;
 *   - transport failures are controlled proxy envelopes, never model answers;
 *   - node:http (not undici fetch) so no hidden 300 s headersTimeout can kill
 *     a legitimate long request.
 */
export const VOXSOAP_BASE_URL =
  process.env.VOXSOAP_BASE_URL ?? 'http://127.0.0.1:8321';

/** Sync /draft still budgets for the slow torch path; async job routes use
 * short, explicit budgets (see each route). */
export const VOXSOAP_TIMEOUT_MS = Number(
  process.env.VOXSOAP_TIMEOUT_MS ?? 1_200_000
);

export function staffRoleOf(req: NextRequest): ClinicStaffRole {
  const roleHeader = (req.headers.get('x-staff-role') ??
    'veterinarian') as ClinicStaffRole;
  return ['veterinarian', 'assistant', 'receptionist', 'admin'].includes(
    roleHeader
  )
    ? roleHeader
    : 'veterinarian';
}

export function isReceptionist(req: NextRequest): boolean {
  return staffRoleOf(req) === 'receptionist';
}

export function forwardStaffHeaders(
  req: NextRequest
): Record<string, string> {
  const header = (name: string) => req.headers.get(name) ?? '';
  return {
    'x-staff-role': header('x-staff-role'),
    'x-staff-id': header('x-staff-id'),
    'x-staff-name': header('x-staff-name'),
    'x-clinic-id': header('x-clinic-id'),
  };
}

/** FR-6 parity with /api/clinic/vox-soap/extract: clinical SOAP dictation is
 * a veterinarian/assistant/admin action. Same `{ error }` shape as the
 * pre-existing protected POST routes (the UI already renders it). */
export function receptionistForbidden(action: string): NextResponse {
  return NextResponse.json(
    {
      error: `Forbidden (FR-6): Receptionists cannot ${action}.`,
    },
    { status: 403 }
  );
}

/** Proxy-caused (not ML-caused) failures keep the contract shape: controlled,
 * clearly labeled as passthrough errors, never a model answer. */
export function proxyError(
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

export function describeUpstreamError(err: unknown): {
  status: number;
  code: string;
  message: string;
} {
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

export interface UpstreamAnswer {
  status: number;
  contentType: string | null;
  body: string;
}

/**
 * Owner proxy fix (2026-11-04): undici's global fetch enforces a FIXED 300 s
 * `headersTimeout` — a minutes-long local draft gets its socket killed with
 * `UND_ERR_HEADERS_TIMEOUT` and `AbortSignal.timeout` CANNOT raise that cap.
 * Every proxied call therefore rides `node:http` (no headersTimeout), with the
 * whole budget enforced via `req.setTimeout` and a sentinel
 * `TIMEOUT_BUDGET_<N>s` error classified as the honest 504 `upstream_timeout`;
 * a connection refusal stays 502 `service_unreachable`.
 */
export function requestUpstream(
  urlString: string,
  options: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: Buffer;
    budgetMs: number;
  }
): Promise<UpstreamAnswer> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const body = options.body;
    const upstream = http.request(
      {
        host: url.hostname,
        port: Number(url.port || 80),
        path: `${url.pathname}${url.search}`,
        method: options.method,
        headers: {
          ...options.headers,
          ...(body ? { 'content-length': String(body.length) } : {}),
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
    // Draft inference is SILENT until the next poll/final envelope, so socket
    // inactivity IS the honest budget — nothing beneath it can abort at 300 s.
    upstream.setTimeout(options.budgetMs, () => {
      upstream.destroy(
        new Error(`TIMEOUT_BUDGET_${Math.round(options.budgetMs / 1000)}s`)
      );
    });
    upstream.on('error', (reqErr) => reject(reqErr));
    upstream.end(body);
  });
}

export function answerToResponse(answer: UpstreamAnswer): NextResponse {
  return new NextResponse(answer.body, {
    status: answer.status,
    headers: {
      'content-type': answer.contentType ?? 'application/json',
      'cache-control': 'no-store',
    },
  });
}

export async function passThrough(upstream: Response): Promise<NextResponse> {
  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    },
  });
}
