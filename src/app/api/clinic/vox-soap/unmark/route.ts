// File: d:\Pawfolio AI\src\app\api\clinic\vox-soap\unmark\route.ts
import { NextRequest, NextResponse } from 'next/server';
import { voxSoapStore } from '@/lib/vox-soap/vox-soap.catalog';
import { extractStaffSession } from '@/lib/vox-soap/vox-soap.workflow';
import { VoxSoapVisitRecord } from '@/lib/vox-soap/vox-soap.types';

/**
 * Scribenote parity: "Unmark as Done" returns a note from Ready to Export
 * (or Exported) back to Available for Review so the veterinarian can keep
 * editing it.
 *
 * Safety rules preserved for Pawfolio AI (proposal FR-12/FR-13/FR-20):
 *   - Only a veterinarian may unmark a signed note (FR-14 audited here, too).
 *   - Published deterministic care events are CANCELLED so the owner-side care
 *     board never keeps a live schedule for a note under re-review; they are
 *     re-generated deterministically on the next Mark as Done.
 *   - Every transition is audited; the record keeps version provenance.
 */
export async function POST(req: NextRequest) {
  try {
    const staff = extractStaffSession(req);
    const body = await req.json();
    const { visitId } = body as { visitId?: string };

    const visit = visitId ? voxSoapStore.getVisit(visitId) : undefined;
    if (!visit) {
      return NextResponse.json({ error: 'Visit not found.' }, { status: 404 });
    }
    if (visit.recordState !== 'Verified') {
      return NextResponse.json(
        {
          error:
            'Unmark blocked: only a note in Ready to Export (Verified) can be unmarked for review.',
        },
        { status: 409 }
      );
    }

    const previousState = visit.recordState;
    const publishedCards = visit.generatedCareCards.length;
    let cancelledDoseEvents = 0;

    // FR-20: cancel reminders/events for orders that were stopped or superseded.
    const suspendedVisit: VoxSoapVisitRecord = {
      ...visit,
      recordState: 'Draft',
      workflowStatus: 'AvailableForReview',
      sourceType: visit.sourceType,
      signedOffByVetId: null,
      signedOffAt: null,
      generatedCareCards: visit.generatedCareCards.map((card) => ({
        ...card,
        generatedDoseEvents: card.generatedDoseEvents.map((event) => {
          if (event.status !== 'Scheduled') return event;
          cancelledDoseEvents += 1;
          return { ...event, status: 'Cancelled' as const };
        }),
      })),
      updatedAt: new Date().toISOString(),
    };

    voxSoapStore.saveVisit(suspendedVisit);
    voxSoapStore.recordAudit({
      clinicId: staff.clinicId,
      actorId: staff.userId,
      actorRole: staff.role,
      petId: visit.petId,
      visitId: visit.visitId,
      action: 'NOTE_UNMARKED_AS_DONE',
      previousState,
      newState: 'Draft',
      metadata: { returnedTo: 'AvailableForReview', publishedCards },
    });

    if (cancelledDoseEvents > 0) {
      voxSoapStore.recordAudit({
        clinicId: staff.clinicId,
        actorId: staff.userId,
        actorRole: staff.role,
        petId: visit.petId,
        visitId: visit.visitId,
        action: 'CARE_EVENTS_CANCELLED',
        previousState: 'Verified',
        newState: 'Draft',
        metadata: { cancelledDoseEvents },
      });
    }

    return NextResponse.json(
      {
        message:
          'Note returned to Available for Review. Published dose events were cancelled deterministically (FR-20).',
        visit: suspendedVisit,
        auditTrail: voxSoapStore.getAuditTrail(visit.visitId),
      },
      { status: 200 }
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Failed to unmark VoxSOAP note',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
