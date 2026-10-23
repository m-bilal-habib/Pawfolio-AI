// File: d:\Pawfolio AI\src\lib\vox-soap\vox-soap.validator.ts
import Fuse from 'fuse.js';
import {
  CLINIC_REVIEWED_DRUG_CATALOG,
  ReviewedDrugEntry,
} from './vox-soap.catalog';
import {
  DeterministicCareCard,
  DeterministicDoseEvent,
  PatientSnapshotContext,
  ValidationBadge,
  ValidatedMedicationOrderDraft,
} from './vox-soap.types';
import { GroundedSoapExtractionOutput } from './vox-soap.schema';

const fuseCatalog = new Fuse<ReviewedDrugEntry>(CLINIC_REVIEWED_DRUG_CATALOG, {
  keys: ['canonicalName', 'aliases'],
  includeScore: true,
  threshold: 0.45,
});

function computeNormalizedSimilarity(a: string, b: string): number {
  const s1 = a.toLowerCase().trim();
  const s2 = b.toLowerCase().trim();
  if (s1 === s2) return 1.0;

  const matrix: number[][] = Array.from({ length: s1.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= s2.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= s1.length; i++) {
    for (let j = 1; j <= s2.length; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  const distance = matrix[s1.length][s2.length];
  return Number((1 - distance / Math.max(s1.length, s2.length, 1)).toFixed(2));
}

export function formatObjectiveWithNullLabels(
  objective: GroundedSoapExtractionOutput['objective']
): Record<string, string> {
  const display: Record<string, string> = {};
  for (const [key, value] of Object.entries(objective)) {
    if (value === null || value === undefined || value === '') {
      display[key] = 'Not mentioned';
    } else if (key === 'weight_kg') {
      display[key] = `${value} kg`;
    } else {
      display[key] = String(value);
    }
  }
  return display;
}

export function crossVerifyWeight(
  extractedWeightKg: number | null,
  snapshot: PatientSnapshotContext
): { status: ValidationBadge; note: string | null } {
  if (extractedWeightKg === null) {
    return { status: 'UNKNOWN', note: 'Weight was not mentioned in consultation.' };
  }
  if (extractedWeightKg <= 0 || extractedWeightKg > 120) {
    return { status: 'MISMATCH', note: `Extracted weight (${extractedWeightKg} kg) is outside plausible range.` };
  }
  if (snapshot.lastRecordedWeightKg === null) {
    return { status: 'MATCH', note: 'First recorded weight for patient.' };
  }
  const deltaRatio = Math.abs(extractedWeightKg - snapshot.lastRecordedWeightKg) / snapshot.lastRecordedWeightKg;
  if (deltaRatio > 0.25) {
    return {
      status: 'NEEDS_REVIEW',
      note: `Weight changed by >25% compared to prior record (${snapshot.lastRecordedWeightKg} kg -> ${extractedWeightKg} kg).`,
    };
  }
  return {
    status: 'MATCH',
    note: `Consistent with prior weight (${snapshot.lastRecordedWeightKg} kg -> ${extractedWeightKg} kg).`,
  };
}

export function validateExtractedMedicationOrders(
  rawOrders: GroundedSoapExtractionOutput['plan']['medication_orders'],
  snapshot: PatientSnapshotContext
): ValidatedMedicationOrderDraft[] {
  return rawOrders.map((order, idx) => {
    const missingRequiredFields: string[] = [];
    if (!order.medicine_name?.trim()) missingRequiredFields.push('medicine_name');
    if (!order.dose_amount?.trim()) missingRequiredFields.push('dose_amount');
    if (!order.frequency?.trim()) missingRequiredFields.push('frequency');
    if (!order.duration?.trim()) missingRequiredFields.push('duration');

    const isComplete = missingRequiredFields.length === 0;
    let drugValidationStatus: ValidationBadge = 'UNKNOWN';
    let matchedCanonicalDrug: string | null = null;
    let similarityScore: number | null = null;
    let allergyConflictDetected = false;
    let allergyConflictReason: string | null = null;

    if (order.medicine_name) {
      const spokenName = order.medicine_name.trim();
      const exactEntry = CLINIC_REVIEWED_DRUG_CATALOG.find(
        (entry) =>
          entry.canonicalName.toLowerCase() === spokenName.toLowerCase() ||
          entry.aliases.some((alias) => alias.toLowerCase() === spokenName.toLowerCase())
      );

      if (exactEntry) {
        drugValidationStatus = 'MATCH';
        matchedCanonicalDrug = exactEntry.canonicalName;
        similarityScore = 1.0;
        allergyConflictDetected = snapshot.knownAllergies.some((allergy) =>
          exactEntry.activeIngredientClass.toLowerCase().includes(allergy.toLowerCase())
        );
        if (allergyConflictDetected) {
          allergyConflictReason = `Patient has a documented allergy conflicting with ${exactEntry.activeIngredientClass}.`;
          drugValidationStatus = 'MISMATCH';
        }
      } else {
        const fuzzyHits = fuseCatalog.search(spokenName);
        if (fuzzyHits.length > 0) {
          const topHit = fuzzyHits[0].item;
          const bestAliasScore = Math.max(
            computeNormalizedSimilarity(spokenName, topHit.canonicalName),
            ...topHit.aliases.map((a) => computeNormalizedSimilarity(spokenName, a))
          );
          matchedCanonicalDrug = topHit.canonicalName;
          similarityScore = bestAliasScore;
          drugValidationStatus = 'NEEDS_REVIEW';
        }
      }
    }

    return {
      orderId: `ord-${Date.now()}-${idx + 1}`,
      ...order,
      validation: {
        isComplete,
        missingRequiredFields,
        drugValidationStatus,
        matchedCanonicalDrug,
        similarityScore,
        allergyConflictDetected,
        allergyConflictReason,
        canConfirmOrder:
          isComplete &&
          drugValidationStatus === 'MATCH' &&
          !allergyConflictDetected,
      },
    };
  });
}

function parseFrequencyPerDay(frequencyText: string): number {
  const normalized = frequencyText.toLowerCase();
  if (normalized.includes('twice') || normalized.includes('12 hour') || normalized.includes('bid')) {
    return 2;
  }
  if (normalized.includes('three') || normalized.includes('8 hour') || normalized.includes('tid')) {
    return 3;
  }
  return 1;
}

function parseDurationDays(durationText: string): number {
  const match = durationText.toLowerCase().match(/(\d+)\s*(day|week|month)/);
  if (!match) return 7;
  const count = parseInt(match[1], 10);
  const unit = match[2];
  if (unit.startsWith('week')) return count * 7;
  if (unit.startsWith('month')) return count * 30;
  return count;
}

export function generateDeterministicCareCards(
  visitId: string,
  petId: string,
  confirmedOrders: ValidatedMedicationOrderDraft[]
): DeterministicCareCard[] {
  const baseDate = new Date();
  baseDate.setMinutes(0, 0, 0);

  return confirmedOrders.map((order) => {
    const dosesPerDay = parseFrequencyPerDay(order.frequency ?? 'once a day');
    const durationDays = parseDurationDays(order.duration ?? '7 days');
    const totalEvents = dosesPerDay * durationDays;
    const hourInterval = Math.floor(24 / dosesPerDay);

    const generatedDoseEvents: DeterministicDoseEvent[] = [];
    for (let i = 0; i < totalEvents; i++) {
      const eventTime = new Date(baseDate.getTime() + i * hourInterval * 60 * 60 * 1000);
      generatedDoseEvents.push({
        eventId: `dose-${order.orderId}-${i + 1}`,
        orderId: order.orderId,
        petId,
        medicineName: order.medicine_name ?? 'Confirmed Medication',
        doseAmount: order.dose_amount ?? '',
        route: order.route ?? 'as directed',
        scheduledIsoTimestamp: eventTime.toISOString(),
        status: 'Scheduled',
      });
    }

    return {
      careCardId: `cc-${order.orderId}`,
      visitId,
      petId,
      orderId: order.orderId,
      title: `${order.medicine_name} — Home Care Schedule`,
      plainLanguageInstructions: `Give ${order.dose_amount} via ${order.route ?? 'directed route'} ${order.frequency} for ${order.duration}. ${order.owner_instructions ?? ''}`.trim(),
      frequencySummary: `${dosesPerDay}x daily for ${durationDays} days (${totalEvents} total doses)`,
      durationDays,
      generatedDoseEvents,
      createdAt: new Date().toISOString(),
    };
  });
}
