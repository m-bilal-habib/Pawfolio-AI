// File: d:\Pawfolio AI\src\app\api\clinic\vox-soap\state\route.ts
import { NextRequest, NextResponse } from 'next/server';
import {
  CLINIC_APPROVED_VACCINES,
  CLINIC_REVIEWED_DRUG_CATALOG,
  voxSoapStore,
} from '@/lib/vox-soap/vox-soap.catalog';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const petId = searchParams.get('petId') ?? 'pet-leo-001';
    const visitId = searchParams.get('visitId') ?? undefined;

    const snapshot = voxSoapStore.getPatientSnapshot(petId);
    const allVisits = voxSoapStore
      .getVisitsByPet(petId)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    // Polling mode (/state?visitId=…): panels watch ONE transcription job, so
    // scope the visit list to that visit to keep responses tiny.
    const visits = visitId ? allVisits.filter((v) => v.visitId === visitId) : allVisits;
    const auditTrail = voxSoapStore
      .getAuditTrail(visitId)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return NextResponse.json(
      {
        snapshot,
        visits,
        auditTrail,
        catalog: {
          reviewedDrugs: CLINIC_REVIEWED_DRUG_CATALOG,
          approvedVaccines: CLINIC_APPROVED_VACCINES,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Failed to load VoxSOAP clinic state',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
