// File: d:\Pawfolio AI\src\app\api\clinic\vox-soap\recordings\route.ts
import { NextRequest, NextResponse } from 'next/server';
import { voxSoapStore } from '@/lib/vox-soap/vox-soap.catalog';
import {
  crossVerifyWeight,
  formatObjectiveWithNullLabels,
} from '@/lib/vox-soap/vox-soap.validator';
import {
  emptyObjectiveRecord,
  extractStaffSession,
} from '@/lib/vox-soap/vox-soap.workflow';
import { WorkflowStatus } from '@/lib/vox-soap/vox-soap.types';

/**
 * Scribenote-style recording start endpoint.
 *
 * The moment the user begins capturing audio "New Recording", a shell visit is
 * persisted in workflowStatus 'Unsynced' (Scribenote: "Recordings that are
 * currently syncing to our servers"). POST /extract later COMPLETES this shell
 * (same visitId) by flipping it Unsynced -> Transcribing -> AvailableForReview.
 * Interrupted or abandoned sessions therefore remain visible in the Inbox
 * exactly like failed/unsynced recordings in Scribenote.
 */
export async function POST(req: NextRequest) {
  try {
    const staff = extractStaffSession(req);
    if (staff.role === 'receptionist') {
      return NextResponse.json(
        { error: 'Forbidden (FR-6): Receptionists cannot initiate clinical SOAP dictation.' },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const petId = typeof body?.petId === 'string' && body.petId.trim()
      ? body.petId.trim()
      : 'pet-leo-001';
    const consentAt =
      typeof body?.consentAt === 'string' && body.consentAt.trim()
        ? body.consentAt.trim()
        : null;

    const snapshot = voxSoapStore.getPatientSnapshot(petId);
    const emptyObjective = emptyObjectiveRecord();
    const weightCheck = crossVerifyWeight(null, snapshot);
    const nowIso = new Date().toISOString();
    // 'rec-' prefix keeps recording shells recognizable in exports/audit.
    const recordingId = `vis-rec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const shell = {
      visitId: recordingId,
      version: 1,
      supersedesVisitId: null,
      petId,
      clinicId: staff.clinicId,
      recordState: 'Draft' as const,
      workflowStatus: 'Unsynced' as WorkflowStatus,
      sourceType: 'AI_Dictation_Draft' as const,
      authorId: staff.userId,
      authorRole: staff.role,
      signedOffByVetId: null,
      signedOffAt: null,
      rawTranscript: '',
      audioRetentionStatus: 'Deleted_After_Transcription' as const,
      workflowRecording: {
        recordingId,
        audioMimeType: null,
        audioSizeBytes: null,
        consentAt,
        startedAt: nowIso,
      },
      groundingAuditNote: null,
      transcribedAt: null,
      exportedAt: null,
      exportCount: 0,
      weightCrossCheckStatus: weightCheck.status,
      weightCrossCheckNote: weightCheck.note,
      subjective: {
        pet_name: null,
        age_mentioned: null,
        presenting_complaint: 'Recording in progress — transcript pending.',
        symptom_duration: null,
        previous_medical_history: null,
        source_quote: '',
      },
      objectiveRaw: emptyObjective,
      objectiveDisplay: formatObjectiveWithNullLabels(emptyObjective),
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
      generatedCareCards: [],
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    voxSoapStore.saveVisit(shell);
    voxSoapStore.recordAudit({
      clinicId: staff.clinicId,
      actorId: staff.userId,
      actorRole: staff.role,
      petId,
      visitId: recordingId,
      action: 'RECORDING_STARTED',
      previousState: null,
      newState: 'Draft',
      metadata: { consentAt, workflowStatus: 'Unsynced' },
    });

    return NextResponse.json(
      { message: 'Recording started (Unsynced).', recordingId, visit: shell },
      { status: 201 }
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Failed to start VoxSOAP recording shell',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
