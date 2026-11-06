// File: d:\Pawfolio AI\src\lib\vox-soap\voxsoap-ml.client.ts

/**
 * Phase 5 client for the LOCAL VoxSOAP ML service, reached through the
 * passthrough proxy `/api/voxsoap/[route]` (which forwards to the FastAPI
 * app at VOXSOAP_BASE_URL). This client NEVER redirects a failure to another
 * provider: whatever controlled envelope comes back (400 / 422 / 501 / 503)
 * is handed to the UI untouched so honest ML failures stay honest ML
 * failures — never a synthesized Gemini answer.
 */
import type {
  VoxSoapMLCall,
  VoxSoapMLEnvelope,
} from './voxsoap-ml.types';

export interface VoxSoapMLStaffHeaders {
  role: string;
  id: string;
  name: string;
}

/** Slightly above the proxy budget so the proxy's controlled 504 always wins
 * the race instead of an opaque client-side abort (proxy budget default:
 * 1,200,000 ms = 20 min; +15 s here). Cold bf16 3B loads measured 989-1,132 s
 * and a paged warm draft reached ~1,100 s - the client must never be the
 * first one to give up on a healthy inference. */
const CLIENT_TIMEOUT_MS = 1_215_000;

function staffHeadersToInit(staff: VoxSoapMLStaffHeaders): Record<string, string> {
  return {
    'x-staff-role': staff.role,
    'x-staff-id': staff.id,
    'x-staff-name': staff.name,
    'x-clinic-id': 'clinic-lhr-01',
  };
}

/** Parses an upstream/proxy envelope; a non-envelope payload is surfaced as
 * an honest `unparseable_response` rather than a guessed success. */
function toEnvelope(raw: string): VoxSoapMLEnvelope {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
      return parsed as VoxSoapMLEnvelope;
    }
  } catch {
    // fall through to the honest fallback
  }
  return {
    ok: false,
    error: 'unparseable_response',
    message: 'The VoxSOAP ML service response was not a contract envelope.',
    detail: raw.slice(0, 400),
    serving_mode: null,
    model_scale: 'UNKNOWN',
    note: 'passthrough contract violation — surfaced verbatim, never rerouted',
  };
}

async function call(
  route: string,
  init: RequestInit,
  staff: VoxSoapMLStaffHeaders
): Promise<VoxSoapMLCall> {
  let status = 0;
  let raw = '';
  try {
    const res = await fetch(`/api/voxsoap/${route}`, {
      ...init,
      headers: { ...init.headers, ...staffHeadersToInit(staff) },
      cache: 'no-store',
      signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
    });
    status = res.status;
    raw = await res.text();
  } catch (err) {
    // Timeout or network break between the page and THIS app's proxy.
    return {
      status: 0,
      envelope: {
        ok: false,
        error: 'transport_failure',
        message:
          err instanceof Error && err.name === 'TimeoutError'
            ? 'The request to the VoxSOAP ML proxy timed out before a response arrived.'
            : 'The VoxSOAP ML proxy could not be reached from this page.',
        serving_mode: null,
        model_scale: 'UNKNOWN',
        note: 'client-side transport error — nothing invented, nothing rerouted',
      },
    };
  }
  return { status, envelope: toEnvelope(raw) };
}

export function mlHealth(staff: VoxSoapMLStaffHeaders): Promise<VoxSoapMLCall> {
  return call('health', { method: 'GET' }, staff);
}

export function mlUnload(
  component: 'asr' | 'soap' | 'roman' | 'all',
  staff: VoxSoapMLStaffHeaders
): Promise<VoxSoapMLCall> {
  return call(
    'unload',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ component }) },
    staff
  );
}

/** `/transcribe` language contract — mirrors the ml-serving API layer
 * ("ur" | "en" | "auto"; anything else is an honest 400 upstream). */
export type VoxSoapMLLanguage = 'ur' | 'en' | 'auto';

/** Sends a 16 kHz mono PCM WAV. The service returns an honest 400 for any
 * other rate — the client-side capture path guarantees 16 kHz. The optional
 * language field tags the Whisper decoder (`ur`/`en`) or asks the model to
 * auto-detect (`auto`); the service defaults to `ur` when omitted. */
export function mlTranscribe(
  wav: Blob,
  staff: VoxSoapMLStaffHeaders,
  language?: VoxSoapMLLanguage
): Promise<VoxSoapMLCall> {
  const formData = new FormData();
  formData.append('audio', wav, 'consultation-16k.wav');
  if (language) formData.append('language', language);
  return call('transcribe', { method: 'POST', body: formData }, staff);
}

export function mlDraft(
  transcript: string,
  staff: VoxSoapMLStaffHeaders
): Promise<VoxSoapMLCall> {
  return call(
    'draft',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transcript }) },
    staff
  );
}

/** Latency label for badge rows — "3.42 s" or a dash when absent. */
export function latencyLabel(latencyS: number | undefined | null): string {
  if (typeof latencyS !== 'number' || !Number.isFinite(latencyS)) return '—';
  return `${latencyS.toFixed(2)} s`;
}
