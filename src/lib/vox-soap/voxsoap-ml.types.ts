// File: d:\Pawfolio AI\src\lib\vox-soap\voxsoap-ml.types.ts

/**
 * VoxSOAP ML serving contract (Phase 5) — TypeScript mirror of the Python
 * FastAPI envelopes in `ml-serving/app.py`. The Next.js proxy route passes
 * the upstream JSON through BYTewise verbatim; these types only describe it
 * so the UI can render model output honestly.
 *
 * Honesty rules baked into this shape (feature contract §9 / phase-4 gate):
 *   - every envelope (success AND controlled error) carries
 *     provider / serving_mode / model_scale;
 *   - serving_mode is "real-provider" or "mocked-test-double" — it labels the
 *     stack, it never promises clinical quality;
 *   - controlled errors note that the request was NOT silently rerouted to
 *     another provider (no Gemini fallback, ever);
 *   - a draft's `guard` object is deterministic ANNOTATION, never a verdict;
 *     the veterinarian remains the reviewer of record.
 */

export type VoxSoapMLServingMode = 'real-provider' | 'mocked-test-double' | string;

/** `/health` carries a per-component map; route envelopes carry a string
 * (or an "UNAVAILABLE …" label when introspection itself failed). */
export type VoxSoapMLScale = string | Record<string, string>;

/** Deterministic guard annotations attached to every `/draft` response
 * (ported rules from ml-training evaluate_soap.py §11.3). */
export interface VoxSoapMLGuard {
  schema: {
    sections_present: Record<string, boolean>;
    complete_schema: boolean;
  };
  facts: {
    unsupported_numbers_in_draft: string[];
    unsupported_med_tokens_in_draft: string[];
    numbers_from_source_missing_in_draft: string[];
    med_tokens_from_source_missing_in_draft: string[];
  };
  unstated_markers_used_in_draft: string[];
  review_hint: string;
}

/** `POST /unload {component: asr|soap|roman|all}` result. */
export interface VoxSoapMLUnloadPayload {
  unload_status: Record<string, boolean>;
  model_scale_after: Record<string, string>;
  note: string;
}

export interface VoxSoapMLTranscribePayload {
  text: string;
  language: string;
  sample_rate: number;
  note: string;
}

export interface VoxSoapMLDraftPayload {
  draft: string;
  generation: string;
  max_new_tokens: number;
  note: string;
  guard: VoxSoapMLGuard;
}

export interface VoxSoapMLRomanPayload {
  roman: string;
  task_prefix: string;
}

export interface VoxSoapMLHealthPayload {
  service: string;
  phase: string;
  default_provider: string;
  providers: {
    ml: { is_mock: boolean; components: Record<string, Record<string, unknown>> };
    gemini: { is_mock: boolean; proxy_url_set: boolean; note: string | null };
  };
  model_scale: Record<string, string>;
  policy: Record<string, string>;
  notes: string[];
}

export interface VoxSoapMLErrorFields {
  error: string | number;
  message: string;
  detail?: unknown;
}

/**
 * One flat shape covering every envelope (per-route payload keys are
 * optional and discriminated with runtime guards in the UI — the proxy keeps
 * the JSON verbatim, so the type never narrows what actually arrives).
 * `model_scale` intentionally appears ONCE with its loose union type: the
 * health route carries a map, every other route a string.
 */
export interface VoxSoapMLEnvelope extends VoxSoapMLErrorFields {
  ok: boolean;
  service?: string;
  phase?: string;
  provider?: string | null;
  serving_mode?: string | null;
  model_scale?: VoxSoapMLScale;
  latency_s?: number | null;
  note?: string | null;

  // /transcribe success payload
  text?: string;
  language?: string;
  sample_rate?: number;

  // /draft success payload
  draft?: string;
  generation?: string;
  max_new_tokens?: number;
  guard?: VoxSoapMLGuard;

  // /roman success payload
  roman?: string;
  task_prefix?: string;

  // /unload success payload
  unload_status?: Record<string, boolean>;
  model_scale_after?: Record<string, string>;

  // /health success payload
  default_provider?: string;
  providers?: VoxSoapMLHealthPayload['providers'];
  policy?: Record<string, string>;
  notes?: string[];
}

/** A client → proxy call keeps the HTTP status next to the parsed envelope so
 * the UI can render honest 4xx/501/503s instead of inventing success states. */
export interface VoxSoapMLCall {
  status: number;
  envelope: VoxSoapMLEnvelope;
}
