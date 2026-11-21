// File: d:\Pawfolio AI\src\app\clinic\(portal)\vox-soap\page.tsx
import React from 'react';
import { VoxSoapWorkspace } from '@/components/vox-soap/VoxSoapWorkspace';

export const metadata = {
  title: 'Pawfolio VoxSOAP — Grounded Consultation Notes',
  description: 'Voice & audio → verbatim-grounded SOAP notes, order verification & care cards',
};

type SearchParams = Promise<{
  petId?: string | string[];
  visitId?: string | string[];
  action?: string | string[];
}>;

function firstParam(val: string | string[] | undefined): string | undefined {
  if (Array.isArray(val)) return val[0];
  return val;
}

export default async function ClinicVoxSoapPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const resolved = (await searchParams) ?? {};
  const petId = firstParam(resolved.petId)?.trim() || 'pet-leo-001';
  const visitId = firstParam(resolved.visitId)?.trim() || undefined;
  const actionRaw = firstParam(resolved.action)?.trim();
  const initialAction =
    actionRaw === 'record' || actionRaw === 'upload' || actionRaw === 'ml-assist'
      ? actionRaw
      : undefined;

  return (
    <VoxSoapWorkspace
      defaultPetId={petId}
      initialVisitId={visitId}
      initialAction={initialAction}
    />
  );
}
