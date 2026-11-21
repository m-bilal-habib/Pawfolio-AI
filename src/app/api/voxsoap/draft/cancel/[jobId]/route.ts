// File: d:\Pawfolio AI\src\app\api\voxsoap\draft\cancel\[jobId]\route.ts
import { NextRequest, NextResponse } from 'next/server';
import {
  VOXSOAP_BASE_URL,
  answerToResponse,
  describeUpstreamError,
  forwardStaffHeaders,
  isReceptionist,
  proxyError,
  receptionistForbidden,
  requestUpstream,
} from '../../../_lib/voxsoap-proxy';

/**
 * POST /api/voxsoap/draft/cancel/<jobId> → FastAPI `POST /draft/cancel/<jobId>`.
 *
 * Flips the per-token cancel Event: the worker stops within one token, so
 * closing the modal / pressing Cancel can no longer leave a zombie CPU
 * decode. The response is the current job snapshot with `cancel_requested`.
 *
 * FR-6 parity: controlling a clinical SOAP draft is a veterinarian/assistant/
 * admin action.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CANCEL_BUDGET_MS = Number(
  process.env.VOXSOAP_DRAFT_CANCEL_TIMEOUT_MS ?? 15_000
);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
): Promise<NextResponse> {
  if (isReceptionist(req)) {
    return receptionistForbidden('cancel clinical SOAP draft jobs');
  }
  const { jobId } = await params;
  try {
    const answer = await requestUpstream(
      `${VOXSOAP_BASE_URL}/draft/cancel/${encodeURIComponent(jobId)}`,
      {
        method: 'POST',
        headers: {
          'content-type':
            req.headers.get('content-type') ?? 'application/json',
          ...forwardStaffHeaders(req),
        },
        body: Buffer.alloc(0),
        budgetMs: CANCEL_BUDGET_MS,
      }
    );
    return answerToResponse(answer);
  } catch (err) {
    const { status, code, message } = describeUpstreamError(err);
    console.warn(
      `[voxsoap-proxy] POST /draft/cancel/<jobId> upstream failure → ${status} ${code}`,
      err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    );
    return proxyError(status, code, message);
  }
}
