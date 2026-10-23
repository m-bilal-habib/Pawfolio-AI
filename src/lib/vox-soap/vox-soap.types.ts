// File: d:\Pawfolio AI\src\lib\vox-soap\vox-soap.types.ts

export type ClinicStaffRole = 'veterinarian' | 'receptionist' | 'assistant' | 'admin';

export type RecordProvenanceState =
  | 'Draft'
  | 'OwnerSubmitted'
  | 'Verified'
  | 'AwaitingSignOff'
  | 'Superseded'
  | 'Cancelled';

export type ValidationBadge =
  | 'MATCH'
  | 'MISMATCH'
  | 'DUPLICATE'
  | 'UNKNOWN'
  | 'NEEDS_REVIEW';

/**
 * Scribenote-aligned note lifecycle status (IS-13 provenance layer complement).
 * `recordState` above answers "who verified this clinically"; `workflowStatus`
 * answers "where is this note in the recording -> review -> export pipeline":
 *   Unsynced            - recording started, audio still syncing/uploading
 *   Transcribing        - audio received, AI transcription/extraction in flight
 *   AvailableForReview  - AI draft ready for veterinarian review & edits
 *   ReadyToExport       - veterinarian Marked as Done (Verified via confirm)
 *   Exported            - note exported to PIMS/download at least once
 *   Failed              - audio processing could not produce a usable draft
 */
export type WorkflowStatus =
  | 'Unsynced'
  | 'Transcribing'
  | 'AvailableForReview'
  | 'ReadyToExport'
  | 'Exported'
  | 'Failed';

export interface RecordingMeta {
  recordingId: string | null;
  audioMimeType: string | null;
  audioSizeBytes: number | null;
  /** ISO timestamp when the client confirmed client-recording consent. */
  consentAt: string | null;
  /** ISO timestamp when the recording session started on the client. */
  startedAt: string;
}

export interface StaffSessionContext {
  userId: string;
  fullName: string;
  clinicId: string;
  role: ClinicStaffRole;
}

/** A patient directory entry: roster patients have createdAtIso 'roster';
 * VoxSOAP auto-generated profiles carry their creation timestamp. */
export interface PatientDirectoryEntry extends PatientSnapshotContext {
  /** ISO timestamp of auto-generation, or the literal 'roster'. */
  createdAtIso: string;
}

export interface PatientSnapshotContext {
  petId: string;
  petName: string;
  species: 'canine' | 'feline' | 'other';
  ageYears: number;
  lastRecordedWeightKg: number | null;
  knownAllergies: string[];
  activeMedications: string[];
}

export interface MedicationOrderValidationResult {
  isComplete: boolean;
  missingRequiredFields: string[];
  drugValidationStatus: ValidationBadge;
  matchedCanonicalDrug: string | null;
  similarityScore: number | null;
  allergyConflictDetected: boolean;
  allergyConflictReason: string | null;
  canConfirmOrder: boolean;
}

export interface ValidatedMedicationOrderDraft {
  orderId: string;
  medicine_name: string | null;
  dose_amount: string | null;
  route: string | null;
  frequency: string | null;
  duration: string | null;
  start_date: string | null;
  owner_instructions: string | null;
  source_quote: string;
  extraction_confidence: number;
  validation: MedicationOrderValidationResult;
}

export interface DeterministicDoseEvent {
  eventId: string;
  orderId: string;
  petId: string;
  medicineName: string;
  doseAmount: string;
  route: string;
  scheduledIsoTimestamp: string;
  status: 'Scheduled' | 'Cancelled';
}

export interface DeterministicCareCard {
  careCardId: string;
  visitId: string;
  petId: string;
  orderId: string;
  title: string;
  plainLanguageInstructions: string;
  frequencySummary: string;
  durationDays: number;
  generatedDoseEvents: DeterministicDoseEvent[];
  createdAt: string;
}

/**
 * Scribenote-parity manual edits: each SOAP section has an editable rich-text
 * body. Values are sanitized HTML (see vox-soap.richtext.ts) attributable to
 * the signed-in clinician; AI-grounded provenance fields are NEVER mutated.
 */
export interface VoxSoapSectionEdits {
  subjective?: string;
  objective?: string;
  assessment?: string;
  plan?: string;
  editedBy?: string;
  editedAt?: string;
}

export interface VoxSoapVisitRecord {
  visitId: string;
  version: number;
  supersedesVisitId: string | null;
  petId: string;
  clinicId: string;
  recordState: RecordProvenanceState;
  workflowStatus: WorkflowStatus;
  sourceType: 'AI_Dictation_Draft' | 'Manual_Fallback_Draft' | 'Veterinarian_Verified';
  authorId: string;
  authorRole: ClinicStaffRole;
  signedOffByVetId: string | null;
  signedOffAt: string | null;
  rawTranscript: string;
  audioRetentionStatus: 'Deleted_After_Transcription' | 'Text_Only_Input' | 'Manual_Fallback';
  workflowRecording: RecordingMeta;
  groundingAuditNote: string | null;
  transcribedAt: string | null;
  exportedAt: string | null;
  exportCount: number;
  weightCrossCheckStatus: ValidationBadge;
  weightCrossCheckNote: string | null;
  subjective: {
    pet_name: string | null;
    age_mentioned: string | null;
    presenting_complaint: string;
    symptom_duration: string | null;
    previous_medical_history: string | null;
    source_quote: string;
  };
  objectiveRaw: Record<string, string | number | null>;
  objectiveDisplay: Record<string, string>;
  assessment: {
    diagnoses_and_findings: Array<{
      condition: string;
      clinical_reasoning: string;
      source_quote: string;
    }>;
    vaccination_status_notes: string | null;
  };
  plan: {
    vaccinations_administered: string[];
    medication_orders: ValidatedMedicationOrderDraft[];
    test_orders: string[];
    follow_up_date_or_interval: string | null;
    general_care_instructions: string | null;
  };
  sectionEdits?: VoxSoapSectionEdits;
  generatedCareCards: DeterministicCareCard[];
  createdAt: string;
  updatedAt: string;
}

export interface VoxSoapAuditEvent {
  auditId: string;
  timestamp: string;
  clinicId: string;
  actorId: string;
  actorRole: ClinicStaffRole;
  petId: string;
  visitId: string;
  action:
    | 'DICTATION_DRAFT_CREATED'
    | 'AI_FALLBACK_TRIGGERED'
    | 'ORDER_VALIDATION_FLAGGED'
    | 'VISIT_SIGNED_OFF_AND_VERIFIED'
    | 'PRIOR_VERSION_SUPERSEDED'
    | 'UNAUTHORIZED_SIGN_OFF_BLOCKED'
    | 'RECORDING_STARTED'
    | 'TRANSCRIPTION_QUEUED'
    | 'PATIENT_PROFILE_AUTO_CREATED'
    | 'GROUNDING_CLAIM_FILTERED'
    | 'NOTE_UNMARKED_AS_DONE'
    | 'CARE_EVENTS_CANCELLED'
    | 'NOTE_TEXT_EDITED'
    | 'WRITING_ASSISTANT_APPLIED'
    | 'NOTE_EXPORTED'
    | 'EXPORT_BLOCKED';
  previousState: RecordProvenanceState | null;
  newState: RecordProvenanceState;
  metadata: Record<string, unknown>;
}
