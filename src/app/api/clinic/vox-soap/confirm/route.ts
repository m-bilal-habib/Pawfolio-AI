// File: d:\Pawfolio AI\src\app\api\clinic\vox-soap\confirm\route.ts
import { NextRequest, NextResponse } from 'next/server';
import { voxSoapStore } from '@/lib/vox-soap/vox-soap.catalog';
import {
  generateDeterministicCareCards,
  validateExtractedMedicationOrders,
} from '@/lib/vox-soap/vox-soap.validator';
import { ClinicStaffRole, VoxSoapVisitRecord } from '@/lib/vox-soap/vox-soap.types';

export async function POST(req: NextRequest) {
  try {
    const staffRole = (req.headers.get('x-staff-role') ?? 'veterinarian') as ClinicStaffRole;
    const staffId = req.headers.get('x-staff-id') ?? 'vet-ali-001';
    const clinicId = req.headers.get('x-clinic-id') ?? 'clinic-lhr-01';

    const body = await req.json();
    const { visitId, correctedMedicationOrders } = body as {
      visitId: string;
      correctedMedicationOrders?: Array<{
        medicine_name: string | null;
        dose_amount: string | null;
        route: string | null;
        frequency: string | null;
        duration: string | null;
        start_date: string | null;
        owner_instructions: string | null;
        source_quote: string;
        extraction_confidence: number;
      }>;
    };

    const existingVisit = voxSoapStore.getVisit(visitId);
    if (!existingVisit) {
      return NextResponse.json({ error: `Visit ${visitId} not found.` }, { status: 404 });
    }

    // FR-14: Prevent receptionists and assistants from approving clinical orders
    if (staffRole !== 'veterinarian') {
      voxSoapStore.recordAudit({
        clinicId,
        actorId: staffId,
        actorRole: staffRole,
        petId: existingVisit.petId,
        visitId: existingVisit.visitId,
        action: 'UNAUTHORIZED_SIGN_OFF_BLOCKED',
        previousState: existingVisit.recordState,
        newState: existingVisit.recordState,
        metadata: { attemptedByRole: staffRole },
      });
      return NextResponse.json(
        { error: 'Forbidden (FR-14): Only an authorized veterinarian can confirm clinical orders.' },
        { status: 403 }
      );
    }

    const snapshot = voxSoapStore.getPatientSnapshot(existingVisit.petId);
    const candidateOrders = correctedMedicationOrders
      ? validateExtractedMedicationOrders(correctedMedicationOrders, snapshot)
      : existingVisit.plan.medication_orders;

    // FR-10: Block confirmation of any order with missing required details or drug mismatches
    const blockedOrders = candidateOrders.filter((o) => !o.validation.canConfirmOrder);
    if (blockedOrders.length > 0) {
      voxSoapStore.recordAudit({
        clinicId,
        actorId: staffId,
        actorRole: staffRole,
        petId: existingVisit.petId,
        visitId: existingVisit.visitId,
        action: 'ORDER_VALIDATION_FLAGGED',
        previousState: existingVisit.recordState,
        newState: 'Draft',
        metadata: { blockedOrders },
      });
      return NextResponse.json(
        {
          error: 'Order confirmation blocked (FR-10): Resolve incomplete fields or unverified drug names.',
          blockedOrders,
        },
        { status: 422 }
      );
    }

    const nowIso = new Date().toISOString();
    const isRevisionOfVerified = existingVisit.recordState === 'Verified';
    const targetVisitId = isRevisionOfVerified
      ? `vis-${Date.now()}-v${existingVisit.version + 1}`
      : existingVisit.visitId;

    // FR-12 & FR-13: If revising an already signed note, mark prior record as Superseded
    if (isRevisionOfVerified) {
      existingVisit.recordState = 'Superseded';
      existingVisit.updatedAt = nowIso;
      voxSoapStore.saveVisit(existingVisit);
      voxSoapStore.recordAudit({
        clinicId,
        actorId: staffId,
        actorRole: staffRole,
        petId: existingVisit.petId,
        visitId: existingVisit.visitId,
        action: 'PRIOR_VERSION_SUPERSEDED',
        previousState: 'Verified',
        newState: 'Superseded',
        metadata: { supersededByVisitId: targetVisitId },
      });
    }

    // FR-15 & FR-16 & NFR-7: Atomically generate deterministic Care Cards & Dose Schedules
    const generatedCareCards = generateDeterministicCareCards(
      targetVisitId,
      existingVisit.petId,
      candidateOrders
    );

    const verifiedVisit: VoxSoapVisitRecord = {
      ...existingVisit,
      visitId: targetVisitId,
      version: isRevisionOfVerified ? existingVisit.version + 1 : existingVisit.version,
      supersedesVisitId: isRevisionOfVerified ? existingVisit.visitId : existingVisit.supersedesVisitId,
      recordState: 'Verified',
      // Scribenote parity: "Mark as Done" moves the note into Ready to Export.
      workflowStatus: 'ReadyToExport',
      sourceType: 'Veterinarian_Verified',
      signedOffByVetId: staffId,
      signedOffAt: nowIso,
      plan: {
        ...existingVisit.plan,
        medication_orders: candidateOrders,
      },
      generatedCareCards,
      updatedAt: nowIso,
    };

    voxSoapStore.saveVisit(verifiedVisit);
    voxSoapStore.recordAudit({
      clinicId,
      actorId: staffId,
      actorRole: staffRole,
      petId: verifiedVisit.petId,
      visitId: verifiedVisit.visitId,
      action: 'VISIT_SIGNED_OFF_AND_VERIFIED',
      previousState: 'Draft',
      newState: 'Verified',
      metadata: {
        careCardsGenerated: generatedCareCards.length,
        version: verifiedVisit.version,
        readyToExport: true,
      },
    });

    return NextResponse.json(
      {
        message: 'Visit SOAP verified and deterministic care schedules published.',
        visit: verifiedVisit,
        auditTrail: voxSoapStore.getAuditTrail(verifiedVisit.visitId),
      },
      { status: 200 }
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Failed to confirm VoxSOAP visit',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
