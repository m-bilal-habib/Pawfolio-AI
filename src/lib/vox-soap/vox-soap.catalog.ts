// File: d:\Pawfolio AI\src\lib\vox-soap\vox-soap.catalog.ts
import {
  PatientDirectoryEntry,
  PatientSnapshotContext,
  VoxSoapAuditEvent,
  VoxSoapVisitRecord,
} from './vox-soap.types';

export interface ReviewedDrugEntry {
  canonicalName: string;
  aliases: string[];
  activeIngredientClass: string;
  defaultRoute: string;
}

export const CLINIC_REVIEWED_DRUG_CATALOG: ReviewedDrugEntry[] = [
  {
    canonicalName: 'Posatex Otic Suspension',
    aliases: ['Posatex', 'Posatex ear drops', 'Posatex drops'],
    activeIngredientClass: 'Orbifloxacin / Mometasone / Posaconazole',
    defaultRoute: 'otic (ear)',
  },
  {
    canonicalName: 'Epi-Otic Advanced Ear Cleaner',
    aliases: ['Epi-Otic', 'daily ear cleaner', 'medicated ear cleaner'],
    activeIngredientClass: 'Salicylic Acid Otic Cleanser',
    defaultRoute: 'otic (ear)',
  },
  {
    canonicalName: 'Apoquel 16mg Chewable',
    aliases: ['Apoquel', 'Apoquel 16mg', 'Oclacitinib'],
    activeIngredientClass: 'JAK Inhibitor',
    defaultRoute: 'oral',
  },
  {
    canonicalName: 'Clavamox Drops / Tablets',
    aliases: ['Clavamox', 'Amoxicillin-Clavulanate'],
    activeIngredientClass: 'Penicillin / Beta-Lactam',
    defaultRoute: 'oral',
  },
  {
    canonicalName: 'Metacam Oral Suspension',
    aliases: ['Metacam', 'Meloxicam'],
    activeIngredientClass: 'NSAID',
    defaultRoute: 'oral',
  },
];

export const CLINIC_APPROVED_VACCINES = [
  'DHPP',
  'Rabies',
  'Bordetella',
  'Leptospirosis',
  'FVRCP',
];

const MOCK_PATIENT_SNAPSHOTS: Record<string, PatientSnapshotContext> = {
  'pet-leo-001': {
    petId: 'pet-leo-001',
    petName: 'Leo',
    species: 'canine',
    ageYears: 3.5,
    lastRecordedWeightKg: 24.0,
    knownAllergies: ['Penicillin', 'Beta-Lactam'],
    activeMedications: [],
  },
};

class VoxSoapMemoryStore {
  private visits = new Map<string, VoxSoapVisitRecord>();
  private auditTrail: VoxSoapAuditEvent[] = [];
  private idempotencyCache = new Map<string, string>();
  /**
   * Dynamic patient directory: VoxSOAP conversations can AUTO-GENERATE a
   * patient profile when the spoken pet name matches nothing on the roster
   * (grounded strictly in what was said — FR-27/28). The roster patients
   * (MOCK_PATIENT_SNAPSHOTS) always take precedence when ids collide.
   */
  private patients = new Map<string, PatientDirectoryEntry>();

  public getPatientSnapshot(petId: string): PatientSnapshotContext {
    return (
      this.patients.get(petId) ??
      MOCK_PATIENT_SNAPSHOTS[petId] ?? {
        petId,
        petName: 'Unknown Patient',
        species: 'canine',
        ageYears: 1,
        lastRecordedWeightKg: null,
        knownAllergies: [],
        activeMedications: [],
      }
    );
  }

  /** True when the id belongs to a known roster or generated patient. */
  public hasPatient(petId: string): boolean {
    return !!MOCK_PATIENT_SNAPSHOTS[petId] || this.patients.has(petId);
  }

  /** Case-insensitive pet-name lookup across roster + generated profiles. */
  public findPatientByName(petName: string): PatientSnapshotContext | null {
    const target = petName.trim().toLowerCase();
    if (!target) return null;
    const rosterHit = Object.values(MOCK_PATIENT_SNAPSHOTS).find(
      (p) => p.petName.toLowerCase() === target
    );
    if (rosterHit) return rosterHit;
    for (const entry of this.patients.values()) {
      if (entry.petName.trim().toLowerCase() === target) return entry;
    }
    return null;
  }

  /** Single source of truth for auto-generated patient profiles. */
  public upsertPatient(
    profile: Omit<PatientDirectoryEntry, 'createdAtIso'> & { createdAtIso?: string }
  ): PatientDirectoryEntry {
    const entry: PatientDirectoryEntry = {
      ...profile,
      createdAtIso: profile.createdAtIso ?? new Date().toISOString(),
    };
    this.patients.set(entry.petId, entry);
    return entry;
  }

  /** Roster (curated) + dynamically generated patients, newest profiles last. */
  public listPatients(): PatientDirectoryEntry[] {
    const roster = Object.values(MOCK_PATIENT_SNAPSHOTS).map((p) => ({
      ...p,
      createdAtIso: 'roster',
    }));
    return [...roster, ...Array.from(this.patients.values())];
  }

  public saveVisit(record: VoxSoapVisitRecord): VoxSoapVisitRecord {
    this.visits.set(record.visitId, record);
    return record;
  }

  public getVisit(visitId: string): VoxSoapVisitRecord | undefined {
    return this.visits.get(visitId);
  }

  public getVisitsByPet(petId: string): VoxSoapVisitRecord[] {
    return Array.from(this.visits.values()).filter((v) => v.petId === petId);
  }

  public listAllVisits(): VoxSoapVisitRecord[] {
    return Array.from(this.visits.values());
  }

  public recordAudit(event: Omit<VoxSoapAuditEvent, 'auditId' | 'timestamp'>): VoxSoapAuditEvent {
    const fullEvent: VoxSoapAuditEvent = {
      ...event,
      auditId: `aud-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
    };
    this.auditTrail.push(fullEvent);
    return fullEvent;
  }

  public getAuditTrail(visitId?: string): VoxSoapAuditEvent[] {
    if (!visitId) return [...this.auditTrail];
    return this.auditTrail.filter((a) => a.visitId === visitId);
  }

  public getIdempotentVisitId(key: string): string | undefined {
    return this.idempotencyCache.get(key);
  }

  public setIdempotentVisitId(key: string, visitId: string): void {
    this.idempotencyCache.set(key, visitId);
  }
}

const globalForVoxSoap = globalThis as unknown as {
  voxSoapStore?: VoxSoapMemoryStore;
};

export const voxSoapStore =
  globalForVoxSoap.voxSoapStore ?? new VoxSoapMemoryStore();

if (process.env.NODE_ENV !== 'production') {
  globalForVoxSoap.voxSoapStore = voxSoapStore;
}
