// File: d:\Pawfolio AI\src\app\api\clinic\vox-soap\export\route.ts
import { NextRequest, NextResponse } from 'next/server';
import { voxSoapStore } from '@/lib/vox-soap/vox-soap.catalog';
import { extractStaffSession } from '@/lib/vox-soap/vox-soap.workflow';
import { richTextToPlainText } from '@/lib/vox-soap/vox-soap.richtext';
import { VoxSoapVisitRecord } from '@/lib/vox-soap/vox-soap.types';

/**
 * Scribenote parity export endpoint.
 *
 * Scribenote only lets notes leaving "Ready to Export" (Marked as Done) be
 * exported, so export is refused for pure drafts and any non-verified states,
 * while re-exporting an already Exported note stays allowed.
 */
function formatSoapExport(visit: VoxSoapVisitRecord): string {
  const s = visit.subjective;
  const edits = visit.sectionEdits;
  const lines: string[] = [];
  lines.push(`PET RECORD SOAP — ${visit.petId} — v${visit.version} (${visit.recordState})`);
  lines.push('');

  lines.push('SUBJECTIVE');
  lines.push(
    `Patient ${s.pet_name ?? 'Not mentioned'}${s.age_mentioned ? ` (${s.age_mentioned})` : ''} — presenting complaint: ${s.presenting_complaint}`
  );
  if (s.symptom_duration) lines.push(`Symptom duration: ${s.symptom_duration}`);
  if (s.previous_medical_history) lines.push(`History: ${s.previous_medical_history}`);
  if (s.source_quote) lines.push(`Grounded transcript source: "${s.source_quote}"`);
  if (edits?.subjective) {
    lines.push(`Veterinarian-edited narrative (${edits.editedBy ?? 'clinician'}):`);
    lines.push(richTextToPlainText(edits.subjective));
  }
  lines.push('');

  lines.push(`OBJECTIVE (${Object.values(visit.objectiveDisplay).filter((v) => v !== 'Not mentioned').length}/23 documented)`);
  for (const [key, value] of Object.entries(visit.objectiveDisplay)) {
    if (value !== 'Not mentioned') lines.push(`- ${key}: ${value}`);
  }
  lines.push(
    `Weight cross-check (${visit.weightCrossCheckStatus}): ${visit.weightCrossCheckNote ?? 'n/a'}`
  );
  if (edits?.objective) {
    lines.push(`Veterinarian-edited exam narrative (${edits.editedBy ?? 'clinician'}):`);
    lines.push(richTextToPlainText(edits.objective));
  }
  lines.push('');

  lines.push('ASSESSMENT');
  for (const d of visit.assessment.diagnoses_and_findings) {
    lines.push(`- ${d.condition}: ${d.clinical_reasoning}`);
    lines.push(`  Source: "${d.source_quote}"`);
  }
  if (visit.assessment.vaccination_status_notes) {
    lines.push(`Vaccination status notes: ${visit.assessment.vaccination_status_notes}`);
  }
  if (edits?.assessment) {
    lines.push(`Veterinarian-edited narrative (${edits.editedBy ?? 'clinician'}):`);
    lines.push(richTextToPlainText(edits.assessment));
  }
  lines.push('');

  lines.push('PLAN');
  if (visit.plan.vaccinations_administered.length) {
    lines.push(`- Vaccinations administered today: ${visit.plan.vaccinations_administered.join(', ')}`);
  }
  for (const o of visit.plan.medication_orders) {
    lines.push(
      `- Medication: ${o.validation.matchedCanonicalDrug ?? o.medicine_name ?? 'unspecified'} — dose ${o.dose_amount ?? 'n/a'} via ${o.route ?? 'n/a'} ${o.frequency ?? 'n/a'} for ${o.duration ?? 'n/a'}.`
    );
    if (o.owner_instructions) lines.push(`  Owner instructions: ${o.owner_instructions}`);
  }
  if (visit.plan.test_orders.length) lines.push(`- Tests ordered: ${visit.plan.test_orders.join(', ')}`);
  if (visit.plan.follow_up_date_or_interval) {
    lines.push(`- Follow-up: ${visit.plan.follow_up_date_or_interval}`);
  }
  if (visit.plan.general_care_instructions) {
    lines.push(`- General care: ${visit.plan.general_care_instructions}`);
  }
  if (edits?.plan) {
    lines.push(`Veterinarian-edited plan narrative (${edits.editedBy ?? 'clinician'}):`);
    lines.push(richTextToPlainText(edits.plan));
  }
  lines.push('');

  const cardSummaries = visit.generatedCareCards.length
    ? visit.generatedCareCards.map((c) => `  • ${c.title} — ${c.frequencySummary}`).join('\n')
    : '  • None (published on vet sign-off)';
  lines.push(`OWNER CARE CARDS:`);
  lines.push(cardSummaries);
  lines.push('');

  lines.push(
    `Signed off by: ${visit.signedOffByVetId ?? '(unsigned)'}${visit.signedOffAt ? ` at ${visit.signedOffAt}` : ''}`
  );
  lines.push(`Grounded on verbatim consultation transcript (${visit.rawTranscript.length} chars).`);
  lines.push(
    visit.groundingAuditNote
      ? `Grounding audit: ${visit.groundingAuditNote}`
      : 'Grounding audit: all claims traceable to transcript.'
  );
  return lines.join('\n');
}

export async function POST(req: NextRequest) {
  try {
    const staff = extractStaffSession(req);
    const body = await req.json();
    const { visitId } = body as { visitId?: string };

    const visit = visitId ? voxSoapStore.getVisit(visitId) : undefined;
    if (!visit) {
      return NextResponse.json({ error: 'Visit not found.' }, { status: 404 });
    }

    // Scribenote behavior: only "Ready to Export" (Marked as Done / Verified)
    // notes can be exported; Exported notes may be re-exported any time.
    const exportable =
      visit.recordState === 'Verified' &&
      (visit.workflowStatus === 'ReadyToExport' || visit.workflowStatus === 'Exported');
    if (!exportable) {
      voxSoapStore.recordAudit({
        clinicId: staff.clinicId,
        actorId: staff.userId,
        actorRole: staff.role,
        petId: visit.petId,
        visitId: visit.visitId,
        action: 'EXPORT_BLOCKED',
        previousState: visit.recordState,
        newState: visit.recordState,
        metadata: { attemptedFrom: visit.workflowStatus },
      });
      return NextResponse.json(
        {
          error:
            'Export blocked: a note must be Marked as Done (Ready to Export / Verified) before exporting.',
        },
        { status: 409 }
      );
    }

    const nowIso = new Date().toISOString();
    const exportedVisit: VoxSoapVisitRecord = {
      ...visit,
      workflowStatus: 'Exported',
      exportedAt: nowIso,
      exportCount: visit.exportCount + 1,
      updatedAt: nowIso,
    };
    voxSoapStore.saveVisit(exportedVisit);
    voxSoapStore.recordAudit({
      clinicId: staff.clinicId,
      actorId: staff.userId,
      actorRole: staff.role,
      petId: visit.petId,
      visitId: visit.visitId,
      action: 'NOTE_EXPORTED',
      previousState: 'Verified',
      newState: 'Verified',
      metadata: { exportNumber: exportedVisit.exportCount, workflowStatus: 'Exported' },
    });

    return NextResponse.json(
      {
        message: `Note exported (export #${exportedVisit.exportCount}).`,
        visit: exportedVisit,
        exportText: formatSoapExport(exportedVisit),
        auditTrail: voxSoapStore.getAuditTrail(visit.visitId),
      },
      { status: 200 }
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Failed to export VoxSOAP note',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
