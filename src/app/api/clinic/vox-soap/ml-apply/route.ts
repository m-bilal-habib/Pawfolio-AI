// File: d:\Pawfolio AI\src\app\api\clinic\vox-soap\ml-apply\route.ts
import { NextRequest, NextResponse } from 'next/server';
import { voxSoapStore } from '@/lib/vox-soap/vox-soap.catalog';
import { groundedFromVetNoteText } from '@/lib/vox-soap/vox-soap.vetnote';
import {
  crossVerifyWeight,
  formatObjectiveWithNullLabels,
  validateExtractedMedicationOrders,
} from '@/lib/vox-soap/vox-soap.validator';
import { extractStaffSession } from '@/lib/vox-soap/vox-soap.workflow';
import type { VoxSoapVisitRecord } from '@/lib/vox-soap/vox-soap.types';

/**
 * Persists a clinician-reviewed ML Assistive Draft into the clinic VoxSOAP store
 * so it can be edited, validated, confirmed ("Mark as Done"), and exported
 * whether or not a prior draft visit already existed in the workspace.
 *
 * Preserves FR-6 (receptionist 403) and FR-29 (always lands as Draft).
 */
export async function POST(req: NextRequest) {
  try {
    const staff = extractStaffSession(req);
    if (staff.role === 'receptionist') {
      return NextResponse.json(
        { error: 'Forbidden (FR-6): Receptionists cannot create or modify clinical SOAP drafts.' },
        { status: 403 }
      );
    }

    const body = (await req.json()) as {
      petId?: string;
      draftText?: string;
      transcriptText?: string;
      baseVisitId?: string;
    };

    const petId = typeof body.petId === 'string' && body.petId.trim() ? body.petId.trim() : 'pet-leo-001';
    const draftText = typeof body.draftText === 'string' ? body.draftText.trim() : '';
    const transcriptInput = typeof body.transcriptText === 'string' ? body.transcriptText.trim() : '';

    if (!draftText) {
      return NextResponse.json({ error: 'Draft text is empty.' }, { status: 400 });
    }

    const existing =
      typeof body.baseVisitId === 'string' && body.baseVisitId.trim()
        ? voxSoapStore.getVisit(body.baseVisitId.trim())
        : undefined;

    const effectiveTranscript = transcriptInput || existing?.rawTranscript || '';
    const applied = groundedFromVetNoteText(draftText, effectiveTranscript);
    const output = applied.output;
    const snapshot = voxSoapStore.getPatientSnapshot(petId);
    const validatedOrders = validateExtractedMedicationOrders(output.plan.medication_orders, snapshot);
    const weightCheck = crossVerifyWeight(output.objective.weight_kg, snapshot);
    const objectiveDisplay = formatObjectiveWithNullLabels(output.objective);

    const unknownNote = applied.objectiveUnknownLines.length
      ? ` (${applied.objectiveUnknownLines.length} unrecognized objective line(s) preserved in the panel draft: ${applied.objectiveUnknownLines
          .map((l) => `"${l}"`)
          .join('; ')})`
      : '';
    const nowIso = new Date().toISOString();
    const applyAuditLine = `[${nowIso}] Reviewed local AI draft applied to SOAP workspace (vet confirmation required)${unknownNote}`;

    const canUpdateExisting = existing && existing.recordState === 'Draft';
    const visitRecord: VoxSoapVisitRecord = {
      visitId: canUpdateExisting
        ? existing.visitId
        : `vis-ml-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      version: canUpdateExisting ? existing.version : 1,
      supersedesVisitId: canUpdateExisting ? existing.supersedesVisitId : null,
      petId,
      clinicId: staff.clinicId,
      recordState: 'Draft',
      workflowStatus: 'AvailableForReview',
      sourceType: 'ML_Local_Draft',
      authorId: staff.userId,
      authorRole: staff.role,
      signedOffByVetId: null,
      signedOffAt: null,
      rawTranscript: output.verbatim_transcript || effectiveTranscript,
      audioRetentionStatus: existing?.audioRetentionStatus ?? 'Deleted_After_Transcription',
      workflowRecording: existing?.workflowRecording ?? {
        recordingId: null,
        audioMimeType: 'audio/wav',
        audioSizeBytes: null,
        consentAt: nowIso,
        startedAt: nowIso,
      },
      groundingAuditNote: [existing?.groundingAuditNote, applyAuditLine].filter(Boolean).join(' '),
      transcribedAt: existing?.transcribedAt ?? nowIso,
      exportedAt: null,
      exportCount: 0,
      weightCrossCheckStatus: weightCheck.status,
      weightCrossCheckNote: weightCheck.note,
      subjective: {
        pet_name: snapshot.petName || output.subjective.pet_name,
        age_mentioned: output.subjective.age_mentioned,
        presenting_complaint: output.subjective.presenting_complaint,
        symptom_duration: output.subjective.symptom_duration,
        previous_medical_history: output.subjective.previous_medical_history,
        source_quote: output.subjective.source_quote,
      },
      objectiveRaw: output.objective,
      objectiveDisplay,
      assessment: output.assessment,
      plan: {
        ...output.plan,
        medication_orders: validatedOrders,
      },
      generatedCareCards: [],
      createdAt: canUpdateExisting ? existing.createdAt : nowIso,
      updatedAt: nowIso,
    };

    voxSoapStore.saveVisit(visitRecord);
    voxSoapStore.recordAudit({
      clinicId: staff.clinicId,
      actorId: staff.userId,
      actorRole: staff.role,
      petId,
      visitId: visitRecord.visitId,
      action: 'ML_LOCAL_TRANSCRIPTION_DRAFT',
      previousState: canUpdateExisting ? existing.recordState : null,
      newState: 'Draft',
      metadata: {
        appliedFromPanel: true,
        unknownObjectiveLines: applied.objectiveUnknownLines.length,
      },
    });

    return NextResponse.json(
      {
        message: 'Local AI SOAP draft applied to workspace as Draft.',
        visit: visitRecord,
      },
      { status: canUpdateExisting ? 200 : 201 }
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Failed to apply local AI SOAP draft',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
