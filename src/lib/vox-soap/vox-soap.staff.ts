// File: d:\Pawfolio AI\src\lib\vox-soap\vox-soap.staff.ts
import type { Role } from '@/lib/data';

/**
 * VoxSOAP staff identity mapped to the REAL signed-in demo profile.
 *
 * The clinic auth gate (`src/lib/auth.tsx`) is role-based demo auth — the
 * signed-in profile IS the role. Names come from `roleDisplayName` there and
 * ids from that role's demo account email, so every VoxSOAP surface (header
 * chrome, recording panels, sign-off banners, audit rows) shows exactly the
 * person using the profile instead of a hardcoded persona.
 */
export interface VoxSoapStaffIdentity {
  headerRole: 'veterinarian' | 'receptionist' | 'assistant' | 'admin';
  staffId: string;
  staffName: string;
}

export const VOX_SOAP_STAFF: Record<Role, VoxSoapStaffIdentity> = {
  Veterinarian: {
    headerRole: 'veterinarian',
    staffId: 'dr.ahmed@pawfolio.ai',
    staffName: 'Dr. Ahmed',
  },
  Receptionist: {
    headerRole: 'receptionist',
    staffId: 'hina@pawfolio.ai',
    staffName: 'Hina Asif',
  },
  Assistant: {
    headerRole: 'assistant',
    staffId: 'bilal@pawfolio.ai',
    staffName: 'Bilal Khan',
  },
  Admin: {
    headerRole: 'admin',
    staffId: 'sana@pawfolio.ai',
    staffName: 'Sana Malik',
  },
};
