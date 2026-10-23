// File: d:\Pawfolio AI\src\app\clinic\(portal)\vox-soap\page.tsx
import React from 'react';
import { VoxSoapWorkspace } from '@/components/vox-soap/VoxSoapWorkspace';

export const metadata = {
  title: 'Pawfolio VoxSOAP — Grounded Consultation Notes',
  description: 'Voice & audio → verbatim-grounded SOAP notes, order verification & care cards',
};

export default function ClinicVoxSoapPage() {
  return <VoxSoapWorkspace defaultPetId="pet-leo-001"/>;
}
