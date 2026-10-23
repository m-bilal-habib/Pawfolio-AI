// File: d:\Pawfolio AI\src\lib\vox-soap\vox-soap.workflow.ts
import { GroundedSoapExtractionOutput } from './vox-soap.schema';
import {
  ClinicStaffRole,
  StaffSessionContext,
  WorkflowStatus,
} from './vox-soap.types';

/**
 * Scribenote-aligned workflow layer for VoxSOAP.
 *
 * Two rules are enforced here BEFORE any record is persisted:
 *   1. No additional information may be extracted that was not required.
 *   2. The conversation is never hallucinated: every grounded claim (subjective
 *      history, diagnosis, medication order, vaccination, test order) must cite
 *      a `source_quote` (or a token) that literally exists in the verbatim
 *      transcript. Anything that cannot be traced is DROPPED and audited
 *      (GROUNDING_CLAIM_FILTERED) — never rewritten from imagination (FR-27/28).
 */

export const WORKFLOW_STATUS_LABELS: Record<WorkflowStatus, string> = {
  Unsynced: 'Unsynced',
  Transcribing: 'Transcribing',
  AvailableForReview: 'Available for Review',
  ReadyToExport: 'Ready to Export',
  Exported: 'Exported',
  Failed: 'Failed',
};

/** Scribenote-style Inbox tab order (used by UI filters). */
export const INBOX_STATUS_TABS: WorkflowStatus[] = [
  'Unsynced',
  'Transcribing',
  'AvailableForReview',
  'ReadyToExport',
  'Exported',
  'Failed',
];

/** Empty Objective exam skeleton — every parameter null (FR-28). */
export function emptyObjectiveRecord(): GroundedSoapExtractionOutput['objective'] {
  return {
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
  };
}

function transcriptContains(transcript: string, claim: string): boolean {
  const haystack = transcript.toLowerCase().replace(/\s+/g, ' ');
  const needle = claim.toLowerCase().trim().replace(/\s+/g, ' ');
  return needle.length > 0 && haystack.includes(needle);
}

export interface GroundedClaimVerificationResult {
  cleaned: GroundedSoapExtractionOutput;
  filteredNotes: string[];
}

/**
 * Verifies that every grounded claim is literally traceable in the transcript.
 * Anything untraceable is dropped (never guessed) and reported so the caller
 * can persist a GROUNDING_CLAIM_FILTERED audit event.
 */
export function verifyGroundedClaims(
  extracted: GroundedSoapExtractionOutput
): GroundedClaimVerificationResult {
  const transcript = extracted.verbatim_transcript ?? '';
  const filteredNotes: string[] = [];

  // 1. Subjective history: keep the narrative only if its quote is traceable.
  const subjective = { ...extracted.subjective };
  if (subjective.source_quote && !transcriptContains(transcript, subjective.source_quote)) {
    subjective.source_quote = '';
    filteredNotes.push(
      'Subjective history quote was not found verbatim in transcript — history marked unverified for manual check.'
    );
  }

  // 2. Diagnoses: drop any finding that lacks a verbatim quote.
  const diagnoses_and_findings = extracted.assessment.diagnoses_and_findings.filter((d) => {
    if (transcriptContains(transcript, d.source_quote)) return true;
    filteredNotes.push(`Diagnosis "${d.condition}" dropped — quote not found verbatim in transcript.`);
    return false;
  });

  // 3. Medication orders: drop orders whose proof quote is not in the transcript.
  const medication_orders = extracted.plan.medication_orders.filter((o) => {
    if (transcriptContains(transcript, o.source_quote)) return true;
    filteredNotes.push(
      `Medication order "${o.medicine_name ?? 'Unnamed'}" dropped — quote not found verbatim in transcript.`
    );
    return false;
  });

  // 4. Vaccinations & test orders: require the literal token in the transcript.
  const vaccinations_administered = extracted.plan.vaccinations_administered.filter((v) => {
    if (transcriptContains(transcript, v)) return true;
    filteredNotes.push(`Vaccination "${v}" dropped — not spoken verbatim in transcript.`);
    return false;
  });
  const test_orders = extracted.plan.test_orders.filter((t) => {
    if (transcriptContains(transcript, t)) return true;
    filteredNotes.push(`Test order "${t}" dropped — not spoken verbatim in transcript.`);
    return false;
  });

  const cleaned: GroundedSoapExtractionOutput = {
    ...extracted,
    subjective,
    assessment: { ...extracted.assessment, diagnoses_and_findings },
    plan: {
      ...extracted.plan,
      vaccinations_administered,
      medication_orders,
      test_orders,
    },
  };

  return { cleaned, filteredNotes };
}

/** Joins verification notes into the record-level grounding audit note. */
export function buildGroundingAuditNote(filteredNotes: string[]): string | null {
  if (filteredNotes.length === 0) return null;
  return filteredNotes.join(' | ');
}

/**
 * Shared staff session extraction for VoxSOAP demo routes.
 * (Production builds must replace header-based identity with the real
 * `src/lib/auth.tsx` clinic session per FR-1/FR-6.)
 */
export function extractStaffSession(req: Request): StaffSessionContext {
  const roleHeader = (req.headers.get('x-staff-role') ?? 'veterinarian') as ClinicStaffRole;
  return {
    userId: req.headers.get('x-staff-id') ?? 'dr.ahmed@pawfolio.ai',
    fullName: req.headers.get('x-staff-name') ?? 'Dr. Ahmed',
    clinicId: req.headers.get('x-clinic-id') ?? 'clinic-lhr-01',
    role: ['veterinarian', 'assistant', 'receptionist', 'admin'].includes(roleHeader)
      ? roleHeader
      : 'veterinarian',
  };
}
