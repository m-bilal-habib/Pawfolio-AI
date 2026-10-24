// File: d:\Pawfolio AI\src\lib\vox-soap\vox-soap.engine.ts
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import {
  CLINIC_APPROVED_VACCINES,
  CLINIC_REVIEWED_DRUG_CATALOG,
  voxSoapStore,
} from './vox-soap.catalog';
import {
  GroundedSoapExtractionOutput,
  GroundedSoapExtractionSchema,
} from './vox-soap.schema';
import {
  PatientSnapshotContext,
  StaffSessionContext,
  VoxSoapVisitRecord,
} from './vox-soap.types';
import {
  crossVerifyWeight,
  formatObjectiveWithNullLabels,
  validateExtractedMedicationOrders,
} from './vox-soap.validator';
import {
  buildGroundingAuditNote,
  verifyGroundedClaims,
} from './vox-soap.workflow';

export interface VoxSoapExtractionInput {
  petId: string;
  staff: StaffSessionContext;
  audioBuffer?: Buffer;
  audioMimeType?: string;
  transcriptText?: string;
  /** Optional id of a recording shell created by POST /recordings (Unsynced). */
  recordingId?: string;
  /** ISO client timestamp proving recording consent (NFR-5 / consent kit). */
  consentAt?: string;
}

/**
 * Scribenote-parity Writing Assistant settings (combinable per docs:
 * "AI Writing Assistant" — Format / Terminology / Abbreviations / Language).
 */
export interface WritingAssistantOptions {
  /** Bullet Point / Paragraph Form / Add Subheadings */
  format?: 'bullet' | 'paragraph' | 'subheadings' | null;
  /** Medical terminology vs layman-friendly wording */
  terminology?: 'medical' | 'laymans' | null;
  /** Use vet abbreviations vs write everything in full words */
  abbreviations?: 'abbreviated' | 'full' | null;
  /** Output language */
  language?: 'English' | 'French' | 'Spanish' | 'Portuguese' | 'German' | null;
}

export interface WritingAssistantRequest {
  text: string;
  sectionLabel: string;
  options: WritingAssistantOptions;
}

export interface WritingAssistantResult {
  text: string;
  assistantModel: string;
}

export class VoxSoapEngine {
  /**
   * Google rotates/retires model names (a 404 "no longer available to new
   * users" hits brand-new API keys) and occasionally returns 503 capacity
   * spikes. The engine therefore tries the configured model first, then a
   * curated chain of currently-serving flash-class models that all support
   * audio input + structured output.
   */
  private static readonly MODEL_FALLBACK_CHAIN = [
    'gemini-3.8-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-flash-latest',
    'gemini-3.1-flash-lite',
  ] as const;

  private ai: GoogleGenAI | null = null;
  private aiClients: GoogleGenAI[] = [];
  private modelName: string;

  /**
   * Free-tier friendliness (quota fit):
   *   • extraction requests are SERIALIZED — overlapping uploads no longer
   *     double-burn the same RPM budget;
   *   • a model that answers 429 (quota) is quarantined for a short cooldown
   *     so later requests skip it instead of hammering the limit;
   *   • a LIST of API keys (GEMINI_API_KEYS="k1,k2,…", falling back to the
   *     single GEMINI_API_KEY) with a rotating pointer: a retryable error
   *     advances the pointer to the next key and the SAME request retries
   *     immediately — the loop cycles keys×models until one call succeeds or
   *     every key and model is exhausted (see callModelsUntilSuccess).
   */
  private static extractionQueue: Promise<unknown> = Promise.resolve();
  private static rateLimitedUntil = new Map<string, number>();
  private static keyPointer = 0;
  /** ScribeNote-pattern background jobs: attempts + one-job-per-visit lock. */
  private static extractionAttempts = new Map<string, number>();
  private static extractionInFlight = new Set<string>();
  private static jsonSchemaCache: unknown = null;

  private static getSoapJsonSchema(): unknown {
    VoxSoapEngine.jsonSchemaCache ??= z.toJSONSchema(GroundedSoapExtractionSchema);
    return VoxSoapEngine.jsonSchemaCache;
  }

  /** Serializes all Gemini extraction calls behind one promise chain. */
  public extractGroundedSoapDraft(
    input: VoxSoapExtractionInput
  ): Promise<VoxSoapVisitRecord> {
    const queued = VoxSoapEngine.extractionQueue.then(() =>
      this.performGroundedExtraction(input)
    );
    // Keep the queue alive even when a run fails (failure is surfaced to the
    // caller, not to the chain).
    VoxSoapEngine.extractionQueue = queued.then(
      () => undefined,
      () => undefined
    );
    return queued;
  }

  /**
   * Scribenote-pattern ASYNC extraction ("Transcribing" phase):
   *   1. the shell visit flips to workflowStatus 'Transcribing' IMMEDIATELY —
   *      even while the serialized queue is still busy, the dashboard state is
   *      honest;
   *   2. the extraction is queued in the background (fire-and-forget, guarded
   *      by a one-job-per-visit lock); the HTTP response returns at once with
   *      the visitId so clients POLL /state instead of holding the request
   *      open while Gemini works;
   *   3. attempts are audited ('TRANSCRIPTION_QUEUED', attempt #, isRetry) and
   *      on a FAILED attempt the client keeps the audio file — pressing
   *      "↻ Retry transcription" re-sends the SAME file against the SAME
   *      visit (no re-recording, no piling shells). Per NFR-5 the server
   *      retains zero audio regardless of the outcome.
   */
  public queueGroundedSoapExtraction(
    input: VoxSoapExtractionInput
  ): { visitId: string; attempt: number; alreadyQueued: boolean } {
    const visitId = input.recordingId ?? '';
    if (!visitId) {
      throw new Error('queueGroundedSoapExtraction requires a recordingId shell visit.');
    }
    const attempt = (VoxSoapEngine.extractionAttempts.get(visitId) ?? 0) + 1;
    VoxSoapEngine.extractionAttempts.set(visitId, attempt);

    if (VoxSoapEngine.extractionInFlight.has(visitId)) {
      // A double-submit / impatient retry while the same job still runs.
      return { visitId, attempt: attempt - 1, alreadyQueued: true };
    }
    VoxSoapEngine.extractionInFlight.add(visitId);

    // Immediate honest status flip (the worker re-flips 'Transcribing' again
    // once the queue opens — idempotent).
    const shell = voxSoapStore.getVisit(visitId);
    if (shell && shell.workflowStatus !== 'Transcribing') {
      voxSoapStore.saveVisit({
        ...shell,
        workflowStatus: 'Transcribing',
        workflowRecording: {
          ...shell.workflowRecording,
          audioMimeType: input.audioMimeType ?? shell.workflowRecording.audioMimeType,
          audioSizeBytes: input.audioBuffer?.length ?? shell.workflowRecording.audioSizeBytes,
        },
        updatedAt: new Date().toISOString(),
      });
    }

    voxSoapStore.recordAudit({
      clinicId: input.staff.clinicId,
      actorId: input.staff.userId,
      actorRole: input.staff.role,
      petId: input.petId,
      visitId,
      action: 'TRANSCRIPTION_QUEUED',
      previousState: shell ? shell.recordState : null,
      newState: 'Draft',
      metadata: {
        attempt,
        isRetry: attempt > 1,
        queuedAt: new Date().toISOString(),
        audioSizeBytes: input.audioBuffer?.length ?? null,
      },
    });

    const queuedJob = VoxSoapEngine.extractionQueue
      .then(() => this.performGroundedExtraction(input))
      .catch((err) => {
        // Background jobs cannot report to the HTTP caller; log loudly. The
        // visit itself either completed as a fallback draft or the error is
        // visible in the next attempt's audit.
        console.error('[VoxSOAP] background extraction failed:', err);
      })
      .finally(() => VoxSoapEngine.extractionInFlight.delete(visitId));
    VoxSoapEngine.extractionQueue = queuedJob;
    return { visitId, attempt, alreadyQueued: false };
  }

  constructor() {
    this.modelName = process.env.VOX_SOAP_MODEL || 'gemini-3.6-flash';
    // Key rotation list: GEMINI_API_KEYS="key1,key2,…" (comma-separated).
    // A single GEMINI_API_KEY still works — the list just has one entry and
    // every error advances the pointer straight back to it.
    const rawKeyList = [process.env.GEMINI_API_KEYS ?? '', process.env.GEMINI_API_KEY ?? ''].join(
      ','
    );
    const apiKeys = rawKeyList
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean);
    this.aiClients = apiKeys.map((apiKey) => new GoogleGenAI({ apiKey }));
    this.ai = this.aiClients[0] ?? null;
  }

  /**
   * One shared reliability loop for EVERY Gemini call (extraction + assistant):
   *
   *   • pointer rotation over the API-key list — a retryable error advances
   *     the pointer and the SAME request retries IMMEDIATELY on the next key
   *     (no pacing between keys, exactly the clinic's rotation spec);
   *   • after every key was tried on one model → next model (paced for
   *     capacity storms, instant for quota models which get a 60 s cooldown);
   *   • the outer while re-cycles the whole model chain until the budget runs
   *     out, mirroring the previous storm-cycling behavior;
   *   • each attempt carries AbortSignal.timeout so a hung fetch can never
   *     freeze the serialized queue (previously unbounded);
   *   • fatally invalid requests (400 / invalid key) bail out instantly so the
   *     deterministic fallback runs without burning the budget.
   */
  private static classifyCallError(
    message: string
  ): 'model-missing' | 'quota' | 'transient' | 'fatal' {
    if (/\b400\b|INVALID_ARGUMENT|API key not valid/i.test(message)) return 'fatal';
    if (/\b(403|404)\b|NOT_FOUND|PERMISSION_DENIED/i.test(message)) return 'model-missing';
    if (/\b429\b|RESOURCE_EXHAUSTED|\bquota\b/i.test(message)) return 'quota';
    // 503 UNAVAILABLE / 500 INTERNAL / mid-trip socket loss ('fetch failed',
    // ECONNRESET, ENOTFOUND…) / our own attempt-timeout abortion — anything
    // worth re-trying on the next key or model.
    return 'transient';
  }

  private async callModelsUntilSuccess(args: {
    models: string[];
    budgetMs: number;
    attemptTimeoutMs: number;
    backoffs: number[];
    call: (model: string, client: GoogleGenAI, abortSignal: AbortSignal) => Promise<string>;
  }): Promise<{ text: string; model: string }> {
    if (!this.aiClients.length) {
      throw new Error(
        'GEMINI_API_KEY is not configured; switching to deterministic fallback parser.'
      );
    }
    const deadline = Date.now() + args.budgetMs;
    const keyCount = this.aiClients.length;
    let backoffIndex = 0;
    let modelIndex = 0;
    let keysTriedOnModel = 0;
    let lastCallError: unknown = null;

    while (Date.now() < deadline) {
      if (modelIndex >= args.models.length) {
        // Full chain pass done — re-cycle from the first model while budget
        // remains (same storm behavior as before, now per-key aware).
        modelIndex = 0;
        keysTriedOnModel = 0;
      }
      const model = args.models[modelIndex];
      const keyIndex = VoxSoapEngine.keyPointer;
      VoxSoapEngine.keyPointer = (keyIndex + 1) % keyCount;
      const client = this.aiClients[keyIndex];
      try {
        const text = await args.call(model, client, AbortSignal.timeout(args.attemptTimeoutMs));
        return { text, model };
      } catch (callErr) {
        lastCallError = callErr;
        const msg = String(callErr instanceof Error ? callErr.message : callErr);
        const kind = VoxSoapEngine.classifyCallError(msg);
        if (kind === 'fatal') throw callErr;
        keysTriedOnModel++;
        if (kind === 'quota') {
          // Rate-limited on this key+model: quarantine the model briefly and
          // move on to the next key (or model) without extra pacing.
          VoxSoapEngine.rateLimitedUntil.set(model, Date.now() + 60_000);
        }
        if (keysTriedOnModel < keyCount) {
          continue; // pointer already advanced → same request, next key, instantly
        }
        // All keys exhausted for this model → pace transient errors, then try
        // the next model in the chain.
        if (kind !== 'quota') {
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              args.backoffs[backoffIndex] ?? args.backoffs[args.backoffs.length - 1]
            )
          );
          backoffIndex = Math.min(backoffIndex + 1, args.backoffs.length - 1);
        }
        keysTriedOnModel = 0;
        modelIndex++;
      }
    }
    throw lastCallError instanceof Error
      ? lastCallError
      : new Error('No Gemini model served the request before the budget deadline.');
  }

  /**
   * Scribenote-parity Writing Assistant (web-app edit view): rewrites a SOAP
   * section's text per combinable style settings (Format / Terminology /
   * Abbreviations / Language). Same reliability posture as extraction:
   * serialized behind the shared quota-safe queue, model fallback chain, 429
   * cooldown, paced 503 backoff — then an honest error to the caller.
   */
  public async runWritingAssistant(
    input: WritingAssistantRequest
  ): Promise<WritingAssistantResult> {
    if (!this.aiClients.length) {
      throw new Error('Gemini API key is not configured (GEMINI_API_KEYS / GEMINI_API_KEY).');
    }
    if (!input.text || !input.text.trim()) {
      throw new Error('Nothing to rewrite — the section text is empty.');
    }

    const queued = VoxSoapEngine.extractionQueue.then(() =>
      this.performWritingAssistant(input)
    );
    VoxSoapEngine.extractionQueue = queued.then(
      () => undefined,
      () => undefined
    );
    return queued;
  }

  private async performWritingAssistant(
    input: WritingAssistantRequest
  ): Promise<WritingAssistantResult> {
    const maxChars = 12_000;
    const sectionText = input.text.length > maxChars ? input.text.slice(0, maxChars) : input.text;
    const o = input.options ?? {};
    const formatInstruction =
      o.format === 'bullet'
        ? 'Reformat the content into bullet points — each distinct finding, instruction or observation becomes its own concise bullet line ("- ").'
        : o.format === 'subheadings'
        ? 'Organize the content under short, relevant subheadings (e.g. "Presentation", "Diagnostics", "Treatment", "Follow-up") based ONLY on what the text already says. Write each subheading in ALL CAPS on its own line, followed by the related lines.'
        : 'Write the content in full paragraph form — complete, flowing sentences.';
    const terminologyInstruction =
      o.terminology === 'laymans'
        ? 'Use simple, client-friendly layman wording a pet owner can easily understand (avoid jargon).'
        : 'Use formal veterinary medical terminology appropriate for clinical records.';
    const abbreviationsInstruction =
      o.abbreviations === 'abbreviated'
        ? 'Use standard veterinary/medical abbreviations where natural (e.g. BID, SID, PO, SQ, IM, NPL, HR, RR).'
        : 'Write every abbreviation and acronym out in full words (no shorthand).';
    const languageInstruction = o.language && o.language !== 'English'
      ? `Write the ENTIRE output in ${o.language}.`
      : 'Write the output in English.';

    const promptText = [
      `You are Pawfolio's veterinary Writing Assistant. Rewrite the "${input.sectionLabel}" text of a grounded consultation note according to these style settings:`,
      `- Format: ${formatInstruction}`,
      `- Terminology: ${terminologyInstruction}`,
      `- Abbreviations: ${abbreviationsInstruction}`,
      `- Language: ${languageInstruction}`,
      '',
      'HARD RULES:',
      '- This is a clinical record. NEVER invent new diagnoses, exam values, medications, dosages or any fact that is not already present in the text.',
      '- Keep every number, dose, unit, medication name, date and interval exactly as written (only the surrounding wording may change).',
      '- Preserve the author\'s complete meaning; adjust only style, structure, terminology, abbreviations and language.',
      '- Output ONLY the rewritten text itself — no preamble, no markdown code fences, no headings markers like "##", no commentary. (If a subheading style was requested, plain ALL-CAPS subheading lines are allowed.)',
      '',
      'TEXT TO REWRITE:',
      '"""',
      sectionText,
      '"""',
    ].join('\n');

    const nowMs = Date.now();
    const candidateModels = [this.modelName, ...VoxSoapEngine.MODEL_FALLBACK_CHAIN]
      .filter((m, i, a) => a.indexOf(m) === i)
      .filter((m) => (VoxSoapEngine.rateLimitedUntil.get(m) ?? 0) < nowMs);

    // Same key-rotation + model-chain loop as extraction (see
    // callModelsUntilSuccess): pointer advances on every retryable error, the
    // request re-fires on the next key instantly, chain re-cycles to the
    // budget. A hung call is aborted after 25 s instead of holding the queue.
    const outcome = await this.callModelsUntilSuccess({
      models: candidateModels,
      budgetMs: 60_000,
      attemptTimeoutMs: 25_000,
      backoffs: [1_500, 4_000, 8_000],
      call: (model, client, abortSignal) =>
        client.models
          .generateContent({
            model,
            contents: [{ role: 'user', parts: [{ text: promptText }] }],
            config: {
              temperature: 0.3,
              responseMimeType: 'text/plain',
              abortSignal,
            },
          })
          .then((response) => response.text?.trim() ?? ''),
    });
    const rawText = outcome.text;
    const usedModel = outcome.model;

    const cleaned = rawText
      .replace(/^```(?:markdown|text)?\s*|\s*```$/g, '')
      .replace(/^#{1,4}\s+/gm, '')
      .trim();
    if (!cleaned) {
      throw new Error('The Writing Assistant returned an empty rewrite. Try again.');
    }
    return { text: cleaned, assistantModel: usedModel };
  }

  /**
   * Patient identity resolution (auto-match / auto-generate).
   *
   * The capture panels pass petId 'auto' when the clinician does not
   * hand-pick a patient record up-front — the CONVERSATION then decides:
   *
   *   1. An EXPLICIT roster-known petId always wins — the clinician chose
   *      that record on purpose, even if the dialogue names another pet.
   *   2. Otherwise the spoken pet name is matched case-insensitively against
   *      the clinic directory (roster + previously generated profiles).
   *   3. An unknown name AUTO-GENERATES a patient profile grounded strictly
   *      in what the dialogue actually said (FR-27/28 — never guessed):
   *      species from spoken words, age from age_mentioned, last weight from
   *      the objective vitals; knownAllergies/activeMedications stay empty
   *      until the clinician documents them.
   *   4. 'auto' with NO spoken name resolves to the single existing patient
   *      when the clinic has exactly one (demo roster) — audited as such.
   */
  private resolvePatientForConversation(
    input: VoxSoapExtractionInput,
    extracted: GroundedSoapExtractionOutput
  ): { petId: string; mode: 'explicit' | 'matched' | 'created' | 'unresolved' } {
    if (input.petId !== 'auto' && voxSoapStore.hasPatient(input.petId)) {
      return { petId: input.petId, mode: 'explicit' };
    }

    const spokenName = (extracted.subjective.pet_name ?? '').trim();
    if (spokenName) {
      const matched = voxSoapStore.findPatientByName(spokenName);
      if (matched) {
        return { petId: matched.petId, mode: 'matched' };
      }

      // Auto-generate a grounded patient profile for this new patient.
      const verbatim = extracted.verbatim_transcript.toLowerCase();
      const species: PatientSnapshotContext['species'] = /dog|puppy|canine|labrador|retriever|poodle|beagle|shepherd|terrier|spaniel|husky/.test(
        verbatim
      )
        ? 'canine'
        : /cat|kitten|feline|tabby|persian|siamese/.test(verbatim)
        ? 'feline'
        : 'other';
      const ageMatch = (extracted.subjective.age_mentioned ?? '').match(
        /(\d+(?:\.\d+)?)\s*(year|yr|month|mon)/i
      );
      let ageYears = 0; // 0 marks "unknown" on auto-generated profiles
      if (ageMatch) {
        const value = Number(ageMatch[1]);
        ageYears = /month|mon/i.test(ageMatch[2]) ? Number((value / 12).toFixed(2)) : value;
      }
      const created = voxSoapStore.upsertPatient({
        petId: `pet-auto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        petName: spokenName,
        species,
        ageYears,
        lastRecordedWeightKg: extracted.objective.weight_kg ?? null,
        knownAllergies: [],
        activeMedications: [],
      });
      voxSoapStore.recordAudit({
        clinicId: input.staff.clinicId,
        actorId: input.staff.userId,
        actorRole: input.staff.role,
        petId: created.petId,
        visitId: input.recordingId ?? 'pending-visit',
        action: 'PATIENT_PROFILE_AUTO_CREATED',
        previousState: null,
        newState: 'Draft',
        metadata: {
          petName: created.petName,
          species: created.species,
          ageYears: created.ageYears,
          lastRecordedWeightKg: created.lastRecordedWeightKg,
          groundedOn:
            'conversation transcript only (FR-27/28) — unspoken profile fields stay empty',
        },
      });
      return { petId: created.petId, mode: 'created' };
    }

    const directory = voxSoapStore.listPatients();
    const fallback =
      input.petId !== 'auto' && voxSoapStore.hasPatient(input.petId)
        ? input.petId
        : directory.length === 1
        ? directory[0].petId
        : input.petId === 'auto'
        ? 'pet-leo-001'
        : input.petId;
    return { petId: fallback, mode: 'unresolved' };
  }

  private async performGroundedExtraction(
    input: VoxSoapExtractionInput
  ): Promise<VoxSoapVisitRecord> {
    const snapshot = voxSoapStore.getPatientSnapshot(input.petId);
    // Scribenote-style recording shell: when the client started a recording via
    // POST /recordings, the shell visit already exists in state 'Unsynced' and
    // this extraction COMPLETES it instead of creating a fresh visit id.
    const shellVisit = input.recordingId
      ? voxSoapStore.getVisit(input.recordingId)
      : undefined;
    let groundingNotes: string[] = [];
    const drugVocabulary = CLINIC_REVIEWED_DRUG_CATALOG.map(
      (d) => `${d.canonicalName} (${d.aliases.join(', ')})`
    ).join('; ');

    const systemInstruction = `You are VoxSOAP Guard, a strict clinical veterinary documentation scribe for Pawfolio AI.
Convert the veterinary consultation into a structured SOAP JSON object grounded strictly in the conversation.

MANDATORY CLINICAL SAFETY & GROUNDING RULES:
1. NEVER invent, guess, or extrapolate clinical vitals, physical exam findings, or medication dosages (FR-28).
2. For every field in 'objective' that is not explicitly spoken in the consultation, you MUST return null.
3. For every medication order in 'plan.medication_orders', extract ONLY spoken details. If dose_amount, route, frequency, or duration was omitted by the speaker, set that field to null so deterministic validation can block incomplete orders (FR-10).
4. Include an exact verbatim 'source_quote' from the conversation for subjective history, each diagnosis, and each medication order.
5. Bias drug and vaccine spelling toward the clinic's reviewed catalog when phonetically matching: ${drugVocabulary}. Approved vaccines: ${CLINIC_APPROVED_VACCINES.join(', ')}.`;

    let extracted: GroundedSoapExtractionOutput;
    let sourceType: VoxSoapVisitRecord['sourceType'] = 'AI_Dictation_Draft';
    let audioRetentionStatus: VoxSoapVisitRecord['audioRetentionStatus'] =
      input.audioBuffer ? 'Deleted_After_Transcription' : 'Text_Only_Input';
    // Diagnostics surfaced (not swallowed) for the immutable audit log.
    let usedModelForAudit: string | null = null;
    let aiErrorMessage: string | null = null;

    try {
      if (!this.aiClients.length) {
        throw new Error('GEMINI_API_KEY is not configured; switching to deterministic fallback parser.');
      }

      const contents: Array<Record<string, unknown> | string> = [];
      if (input.audioBuffer && input.audioMimeType) {
        contents.push({
          inlineData: {
            data: input.audioBuffer.toString('base64'),
            mimeType: input.audioMimeType,
          },
        });
        contents.push(
          'Transcribe this veterinary consultation verbatim and extract the grounded SOAP JSON.'
        );
      } else if (input.transcriptText) {
        contents.push(
          `Extract the grounded SOAP JSON from this veterinary consultation transcript:\n"""\n${input.transcriptText}\n"""`
        );
      } else {
        throw new Error('Neither audioBuffer nor transcriptText was provided.');
      }

      // Scribenote-style status persistence: an existing 'Unsynced' shell flips
      // to 'Transcribing' the moment AI processing begins, so an interrupted
      // request leaves an auditable state on the server.
      if (shellVisit) {
        voxSoapStore.saveVisit({
          ...shellVisit,
          workflowStatus: 'Transcribing',
          workflowRecording: {
            ...shellVisit.workflowRecording,
            audioMimeType: input.audioMimeType ?? shellVisit.workflowRecording.audioMimeType,
            audioSizeBytes:
              input.audioBuffer?.length ?? shellVisit.workflowRecording.audioSizeBytes,
            consentAt: input.consentAt ?? shellVisit.workflowRecording.consentAt,
          },
          updatedAt: new Date().toISOString(),
        });
      }

      const jsonSchema = VoxSoapEngine.getSoapJsonSchema();

      // Try the configured model, then the curated fallback chain. For AUDIO
      // requests, promote the (less congested) flash-lite model right after
      // the configured one — during capacity storms the big models often fail
      // while lite keeps serving audio transcription.
      // Skip models that are in a 429 cooldown window (quota fit) — if every
      // candidate is cooling down the request falls back honestly.
      const nowMs = Date.now();
      const candidateModels = [
        this.modelName,
        ...(input.audioBuffer
          ? ['gemini-3.1-flash-lite', ...VoxSoapEngine.MODEL_FALLBACK_CHAIN]
          : VoxSoapEngine.MODEL_FALLBACK_CHAIN),
      ]
        .filter((m, i, a) => a.indexOf(m) === i)
        .filter((m) => (VoxSoapEngine.rateLimitedUntil.get(m) ?? 0) < nowMs);

      // Key-pointer rotation + model-chain reliability loop. Audio jobs get a
      // 4-minute budget with 75 s per attempt (transcribing a multi-minute
      // consult legitimately takes minutes of generation); since the caller
      // polls instead of holding an HTTP request open (Scribenote pattern),
      // spending budget on retries no longer blocks any UI. Text jobs keep
      // the old synchronous profile (2 minutes / 40 s per attempt).
      const isAudioJob = !!input.audioBuffer;
      const outcome = await this.callModelsUntilSuccess({
        models: candidateModels,
        budgetMs: isAudioJob ? 240_000 : 120_000,
        attemptTimeoutMs: isAudioJob ? 75_000 : 40_000,
        backoffs: [1_500, 4_000, 8_000, 16_000],
        call: (model, client, abortSignal) =>
          client.models
            .generateContent({
              model,
              contents,
              config: {
                systemInstruction,
                temperature: 0,
                responseMimeType: 'application/json',
                responseJsonSchema: jsonSchema,
                abortSignal,
              },
            })
            .then((response) => response.text?.trim() ?? ''),
      });
      const rawText = outcome.text;
      usedModelForAudit = outcome.model;

      const cleanJson = rawText.replace(/^```json\s*|\s*```$/g, '').trim();
      extracted = GroundedSoapExtractionSchema.parse(JSON.parse(cleanJson));
    } catch (aiError) {
      const message = aiError instanceof Error ? aiError.message : String(aiError);
      aiErrorMessage = message.slice(0, 480);
      // FR-30: Graceful fallback when AI service is unavailable or fails
      sourceType = 'Manual_Fallback_Draft';
      // Retention honesty (NFR-5): if real audio was received it must stay
      // recorded as received-and-scrubbed even on the fallback path.
      // 'Manual_Fallback' is reserved for genuinely empty payloads.
      audioRetentionStatus = input.audioBuffer
        ? 'Deleted_After_Transcription'
        : input.transcriptText && input.transcriptText.trim()
        ? 'Text_Only_Input'
        : 'Manual_Fallback';
      extracted = this.buildManualFallbackTemplate(input.transcriptText ?? '');
    } finally {
      // Ephemeral audio cleanup: zero out buffer reference immediately after transcription
      if (input.audioBuffer) {
        input.audioBuffer.fill(0);
      }
    }

    // Never-hallucinate gate (FR-27/28): every AI claim must be traceable
    // verbatim to the transcript. Untraceable claims are DROPPED (never
    // rewritten) and reported so a GROUNDING_CLAIM_FILTERED event can be audited.
    if (sourceType === 'AI_Dictation_Draft') {
      const verdict = verifyGroundedClaims(extracted);
      extracted = verdict.cleaned;
      groundingNotes = verdict.filteredNotes;
    }

    const validatedOrders = validateExtractedMedicationOrders(
      extracted.plan.medication_orders,
      snapshot
    );
    const weightCheck = crossVerifyWeight(extracted.objective.weight_kg, snapshot);
    const objectiveDisplay = formatObjectiveWithNullLabels(extracted.objective);

    const nowIso = new Date().toISOString();
    const recordingStartedAt = shellVisit ? shellVisit.workflowRecording.startedAt : nowIso;
    const consentAt = input.consentAt ?? shellVisit?.workflowRecording.consentAt ?? null;
    const isFailedDraft =
      sourceType === 'Manual_Fallback_Draft' && !extracted.verbatim_transcript.trim();
    const visitRecord: VoxSoapVisitRecord = {
      visitId: shellVisit
        ? shellVisit.visitId
        : `vis-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      version: shellVisit ? shellVisit.version : 1,
      supersedesVisitId: null,
      petId: input.petId,
      clinicId: input.staff.clinicId,
      recordState: 'Draft', // FR-29: AI output is strictly stored as Draft
      workflowStatus: isFailedDraft ? 'Failed' : 'AvailableForReview',
      sourceType,
      authorId: input.staff.userId,
      authorRole: input.staff.role,
      signedOffByVetId: null,
      signedOffAt: null,
      rawTranscript: extracted.verbatim_transcript,
      audioRetentionStatus,
      workflowRecording: {
        recordingId:
          shellVisit?.workflowRecording.recordingId ?? input.recordingId ?? null,
        audioMimeType:
          input.audioMimeType ?? shellVisit?.workflowRecording.audioMimeType ?? null,
        audioSizeBytes:
          input.audioBuffer?.length ??
          shellVisit?.workflowRecording.audioSizeBytes ??
          null,
        consentAt,
        startedAt: recordingStartedAt,
      },
      groundingAuditNote: buildGroundingAuditNote(groundingNotes),
      transcribedAt: nowIso,
      exportedAt: null,
      exportCount: 0,
      weightCrossCheckStatus: weightCheck.status,
      weightCrossCheckNote: weightCheck.note,
      subjective: extracted.subjective,
      objectiveRaw: extracted.objective,
      objectiveDisplay,
      assessment: extracted.assessment,
      plan: {
        ...extracted.plan,
        medication_orders: validatedOrders,
      },
      generatedCareCards: [], // Empty until Veterinarian confirms and signs off
      createdAt: shellVisit ? shellVisit.createdAt : nowIso,
      updatedAt: nowIso,
    };

    voxSoapStore.saveVisit(visitRecord);
    voxSoapStore.recordAudit({
      clinicId: input.staff.clinicId,
      actorId: input.staff.userId,
      actorRole: input.staff.role,
      petId: input.petId,
      visitId: visitRecord.visitId,
      action:
        sourceType === 'Manual_Fallback_Draft'
          ? 'AI_FALLBACK_TRIGGERED'
          : 'DICTATION_DRAFT_CREATED',
      previousState: shellVisit ? shellVisit.recordState : null,
      newState: 'Draft',
      metadata: {
        audioRetentionStatus,
        orderCount: validatedOrders.length,
        weightCrossCheckStatus: weightCheck.status,
        consentAt,
        workflowCompletedFrom: shellVisit ? shellVisit.workflowStatus : 'New',
        audioSizeRatioDeleted: audioRetentionStatus === 'Deleted_After_Transcription',
        aiModel: usedModelForAudit,
        aiError: aiErrorMessage,
      },
    });

    if (groundingNotes.length > 0) {
      voxSoapStore.recordAudit({
        clinicId: input.staff.clinicId,
        actorId: input.staff.userId,
        actorRole: input.staff.role,
        petId: input.petId,
        visitId: visitRecord.visitId,
        action: 'GROUNDING_CLAIM_FILTERED',
        previousState: 'Draft',
        newState: 'Draft',
        metadata: { filteredClaims: groundingNotes },
      });
    }

    return visitRecord;
  }

  private buildManualFallbackTemplate(rawText: string): GroundedSoapExtractionOutput {
    return {
      verbatim_transcript: rawText || '[Manual Fallback Mode: Audio/AI unavailable]',
      subjective: {
        pet_name: null,
        age_mentioned: null,
        presenting_complaint: rawText
          ? `Manual review required for transcript: ${rawText.slice(0, 160)}...`
          : 'AI service unavailable. Please enter presenting complaint manually.',
        symptom_duration: null,
        previous_medical_history: null,
        // No fake "grounded quote" on the fallback path: without a real
        // transcript there is no verbatim text to cite, and with one the
        // slice IS verbatim (then the UI's quote strip stays honest).
        source_quote: rawText.slice(0, 120),
      },
      objective: {
        temperature: null,
        heart_rate: null,
        weight_kg: null,
        respiratory_rate: null,
        capillary_refill_time: null,
        mucous_membranes: null,
        hydration_status: null,
        body_condition_score: null,
        pain_score: null,
        fear_anxiety_stress_score: null,
        eyes: null,
        ears: null,
        nasal: null,
        oral_dental: null,
        cardiovascular: null,
        respiratory: null,
        neurological: null,
        musculoskeletal: null,
        lymphatic: null,
        gastrointestinal: null,
        reproductive_urinary: null,
        integument: null,
        masses: null,
      },
      assessment: {
        diagnoses_and_findings: [],
        vaccination_status_notes: null,
      },
      plan: {
        vaccinations_administered: [],
        medication_orders: [],
        test_orders: [],
        follow_up_date_or_interval: null,
        general_care_instructions: null,
      },
    };
  }
}

export const voxSoapEngine = new VoxSoapEngine();
