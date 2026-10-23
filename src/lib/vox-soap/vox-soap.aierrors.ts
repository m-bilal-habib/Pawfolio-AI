// File: d:\Pawfolio AI\src\lib\vox-soap\vox-soap.aierrors.ts
/**
 * Shared client helper for the Scribenote-pattern "failed → ↻ Retry" UX.
 *
 * The audit trail records the raw AI-chain error verbatim (`metadata.aiError`)
 * — often a JSON envelope like
 *   {"error":{"code":503,"message":"This model is currently experiencing high
 *    demand…","status":"UNAVAILABLE"}}
 * or a Node network failure string ("fetch failed"). Panels surface a
 * human-readable one-liner for the honest failure banner while the full,
 * unredacted error stays in the immutable audit log.
 */
export interface AiErrorAuditEvent {
  metadata?: Record<string, unknown>;
}

export function aiErrorSummaryFromAudit(
  auditTrail: AiErrorAuditEvent[] | undefined
): string | null {
  const hit = (auditTrail ?? []).find(
    (e) => typeof e.metadata?.aiError === 'string' && (e.metadata.aiError as string).length > 0
  );
  if (!hit) return null;
  const raw = String(hit.metadata?.aiError);
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    if (parsed?.error?.message) return parsed.error.message;
  } catch {
    // Not JSON — use the raw string as-is.
  }
  return raw.length > 180 ? `${raw.slice(0, 180)}…` : raw;
}
