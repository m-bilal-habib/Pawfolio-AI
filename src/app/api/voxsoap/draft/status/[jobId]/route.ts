// File: d:\Pawfolio AI\src\app\api\voxsoap\draft\status\[jobId]\route.ts
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
 * GET /api/voxsoap/draft/status/<jobId> → FastAPI `GET /draft/status/<jobId>`.
 *
 * Pure in-memory status (<10 ms upstream): queued | loading_model |
 * generating | completed | failed | cancelled + tokens_generated /
 * max_new_tokens / elapsed_s, and the FULL /draft envelope once completed.
 * Short budget by design — a status poll must never approach a proxy timeout.
 *
 * FR-6 parity: the payload can include clinical draft text, so receptionists
 * are refused the same way they are refused dictation initiation.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUS_BUDGET_MS = Number(
  process.env.VOXSOAP_DRAFT_STATUS_TIMEOUT_MS ?? 15_000
);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
): Promise<NextResponse> {
  if (isReceptionist(req)) {
    return receptionistForbidden('read clinical SOAP draft jobs');
  }
  const { jobId } = await params;
  try {
    const answer = await requestUpstream(
      `${VOXSOAP_BASE_URL}/draft/status/${encodeURIComponent(jobId)}`,
      {
        method: 'GET',
        headers: forwardStaffHeaders(req),
        budgetMs: STATUS_BUDGET_MS,
      }
    );
    return answerToResponse(answer);
  } catch (err) {
    const { status, code, message } = describeUpstreamError(err);
    console.warn(
      `[voxsoap-proxy] GET /draft/status/<jobId> upstream failure → ${status} ${code}`,
      err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    );
    return proxyError(status, code, message);
  }
}
