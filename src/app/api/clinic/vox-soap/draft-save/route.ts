// File: d:\Pawfolio AI\src\app\api\clinic\vox-soap\draft-save\route.ts
import { NextRequest, NextResponse } from 'next/server';
import { voxSoapStore } from '@/lib/vox-soap/vox-soap.catalog';
import { sanitizeRichTextHtml } from '@/lib/vox-soap/vox-soap.richtext';
import { VoxSoapSectionEdits, VoxSoapVisitRecord } from '@/lib/vox-soap/vox-soap.types';
import { extractStaffSession } from '@/lib/vox-soap/vox-soap.workflow';

/**
 * Scribenote-parity manual note editing: persists the clinician's rich-text
 * edits per SOAP section on a DRAFT note. AI-grounded provenance fields are
 * never mutated — these edits create an attributable clinician-authored layer
 * (`sectionEdits`), audited as NOTE_TEXT_EDITED. Editing a note that is
 * Verified/Exported is refused (unmark first), matching our grounding gates.
 */

const SECTION_KEYS = ['subjective', 'objective', 'assessment', 'plan'] as const;
const MAX_SECTION_HTML = 24_000;

export async function POST(req: NextRequest) {
  try {
    const staff = extractStaffSession(req);
    const body = (await req.json()) as {
      visitId?: string;
      sectionEdits?: Partial<Record<(typeof SECTION_KEYS)[number], unknown>>;
    };

    const visit = body.visitId ? voxSoapStore.getVisit(body.visitId) : undefined;
    if (!visit) {
      return NextResponse.json({ error: 'Visit not found.' }, { status: 404 });
    }

    if (staff.role === 'receptionist') {
      return NextResponse.json(
        { error: 'Receptionists cannot edit clinical SOAP notes (FR-6).' },
        { status: 403 }
      );
    }
    if (visit.recordState !== 'Draft') {
      return NextResponse.json(
        {
          error:
            'Only a draft (Available for Review) note can receive manual edits. Unmark as Done first — this keeps the verified record immutable.',
        },
        { status: 409 }
      );
    }

    const incoming = body.sectionEdits ?? {};
    const sanitized: VoxSoapSectionEdits & { editedBy: string; editedAt: string } = {
      ...visit.sectionEdits,
      editedBy: staff.fullName,
      editedAt: new Date().toISOString(),
    };
    const appliedKeys: string[] = [];
    for (const key of SECTION_KEYS) {
      if (typeof incoming[key] === 'string') {
        sanitized[key] = sanitizeRichTextHtml(
          String(incoming[key]).slice(0, MAX_SECTION_HTML)
        );
        appliedKeys.push(key);
      }
    }
    if (appliedKeys.length === 0 && !visit.sectionEdits) {
      return NextResponse.json(
        { error: 'No section edits were provided.' },
        { status: 400 }
      );
    }

    const nowIso = sanitized.editedAt;
    const updated: VoxSoapVisitRecord = {
      ...visit,
      sectionEdits: sanitized,
      updatedAt: nowIso,
    };
    voxSoapStore.saveVisit(updated);
    voxSoapStore.recordAudit({
      clinicId: staff.clinicId,
      actorId: staff.userId,
      actorRole: staff.role,
      petId: visit.petId,
      visitId: visit.visitId,
      action: 'NOTE_TEXT_EDITED',
      previousState: visit.recordState,
      newState: visit.recordState,
      metadata: { sections: appliedKeys, editedBy: staff.fullName },
    });

    return NextResponse.json({
      message: `Edits saved to ${appliedKeys.length ? appliedKeys.join(', ') : 'existing edits'}.`,
      visit: updated,
      auditTrail: voxSoapStore.getAuditTrail(visit.visitId),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Failed to save note edits',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
