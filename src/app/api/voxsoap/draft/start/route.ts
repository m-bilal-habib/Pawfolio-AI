// File: d:\Pawfolio AI\src\app\api\voxsoap\draft\start\route.ts
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
} from '../../_lib/voxsoap-proxy';

/**
 * POST /api/voxsoap/draft/start → FastAPI `POST /draft/start` (202 + job_id).
 *
 * The ML service accepts the job and returns immediately; this proxy never
 * holds a socket open for the multi-minute CPU decode. The UI then polls
 * `/api/voxsoap/draft/status/<jobId>` every ~2 s. A fast budget here is
 * honest: the upstream only validates + spawns a worker (no model work).
 *
 * FR-6 parity: initiating clinical SOAP dictation is a veterinarian/assistant/
 * admin action → receptionist 403, same as /transcribe and /draft.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const START_BUDGET_MS = Number(
  process.env.VOXSOAP_DRAFT_START_TIMEOUT_MS ?? 30_000
);

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (isReceptionist(req)) {
    return receptionistForbidden('start a clinical SOAP draft');
  }
  try {
    console.info(
      `[voxsoap-proxy] POST /draft/start → ${VOXSOAP_BASE_URL} (budget ${Math.round(
        START_BUDGET_MS / 1000
      )}s, body ${req.headers.get('content-length') ?? '?'}B)`
    );
    const answer = await requestUpstream(
      `${VOXSOAP_BASE_URL}/draft/start`,
      {
        method: 'POST',
        headers: {
          'content-type':
            req.headers.get('content-type') ?? 'application/json',
          ...forwardStaffHeaders(req),
        },
        // Byte-for-byte passthrough: validation + limits stay with the ML
        // service (VOXSOAP_TRANSCRIPT_MAX_CHARS / VOXSOAP_DRAFT_MAX_NEW_TOKENS).
        body: Buffer.from(await req.arrayBuffer()),
        budgetMs: START_BUDGET_MS,
      }
    );
    return answerToResponse(answer);
  } catch (err) {
    const { status, code, message } = describeUpstreamError(err);
    console.warn(
      `[voxsoap-proxy] POST /draft/start upstream failure → ${status} ${code}`,
      err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    );
    return proxyError(status, code, message);
  }
}
