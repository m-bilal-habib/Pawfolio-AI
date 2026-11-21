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

function normalizeAlphaNum(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function computeNormalizedSimilarity(a: string, b: string): number {
  const s1 = normalizeAlphaNum(a);
  const s2 = normalizeAlphaNum(b);
  if (!s1 || !s2) return 0;
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
  return Number((1 - distance / Math.max(s1.length, s2.length, 1)).toFixed(3));
}

/** Double-Metaphone-inspired veterinary pharmacology phonetic encoder. */
export function computeVetPhoneticKey(raw: string): string {
  let s = normalizeAlphaNum(raw);
  if (!s) return '';
  const rules: Array<[RegExp, string]> = [
    [/ph/g, 'f'],
    [/kef/g, 'sef'],
    [/cef/g, 'sef'],
    [/c([iey])/g, 's$1'],
    [/[cq]/g, 'k'],
    [/x/g, 'ks'],
    [/z/g, 's'],
    [/y/g, 'i'],
    [/wh/g, 'w'],
    [/sh/g, 's'],
    [/ch/g, 'k'],
    [/th/g, 't'],
    [/mycin/g, 'misin'],
    [/myzin/g, 'misin'],
    [/brizin/g, 'misin'],
  ];
  for (const [pattern, replacement] of rules) {
    s = s.replace(pattern, replacement);
  }
  let deduped = '';
  for (const ch of s) {
    if (!deduped || deduped[deduped.length - 1] !== ch) deduped += ch;
  }
  if (deduped.length <= 2) return deduped;
  return deduped[0] + deduped.slice(1).replace(/[aeiou]/g, '');
}

function computeCompositeDrugScore(spoken: string, candidate: string): number {
  const s1 = normalizeAlphaNum(spoken);
  const s2 = normalizeAlphaNum(candidate);
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1.0;

  const lev = computeNormalizedSimilarity(s1, s2);
  const phonSim = computeNormalizedSimilarity(
    computeVetPhoneticKey(spoken),
    computeVetPhoneticKey(candidate)
  );
  if (s1.length >= 5 && (s1.includes(s2) || s2.includes(s1))) {
    return Number(Math.min(0.95, Math.max(lev, phonSim, 0.85)).toFixed(2));
  }
  return Number((0.58 * lev + 0.42 * phonSim).toFixed(2));
}

function detectAllergyConflict(
  entry: ReviewedDrugEntry,
  knownAllergies: string[]
): string | null {
  const classes = (entry.allergyClasses ?? []).map((c) => c.toLowerCase());
  const ing = entry.activeIngredientClass.toLowerCase();
  const canon = entry.canonicalName.toLowerCase();
  for (const rawAllergy of knownAllergies) {
    const allergy = rawAllergy.trim().toLowerCase();
    if (!allergy) continue;
    if (
      ing.includes(allergy) ||
      canon.includes(allergy) ||
      classes.some((c) => c.includes(allergy) || allergy.includes(c))
    ) {
      return `Patient has a documented allergy (${rawAllergy}) conflicting with ${entry.activeIngredientClass}.`;
    }
    if (
      (allergy.includes('chicken') || allergy.includes('beef') || allergy.includes('protein')) &&
      entry.containsAnimalProtein
    ) {
      return `Patient has a documented food protein sensitivity (${rawAllergy}) that may conflict with flavored chewable/protein base in ${entry.canonicalName}.`;
    }
  }
  return null;
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
  if (deltaRatio > 0.10) {
    const pct = Math.round(deltaRatio * 100);
    return {
      status: 'NEEDS_REVIEW',
      note: `Weight drifted by ${pct}% (>10% alert) compared to prior record (${snapshot.lastRecordedWeightKg} kg -> ${extractedWeightKg} kg).`,
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
    let confidenceTier: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
    let suggestedPrompt: string | null = null;
    let allergyConflictDetected = false;
    let allergyConflictReason: string | null = null;

    if (order.medicine_name) {
      const spokenName = order.medicine_name.trim();
      // Stage 1 + 2: Exact / Fuse fuzzy + phonetic composite evaluation across entire reviewed catalog
      let bestEntry: ReviewedDrugEntry | null = null;
      let bestScore = 0;

      for (const entry of CLINIC_REVIEWED_DRUG_CATALOG) {
        const score = Math.max(
          computeCompositeDrugScore(spokenName, entry.canonicalName),
          ...entry.aliases.map((alias) => computeCompositeDrugScore(spokenName, alias))
        );
        if (score > bestScore) {
          bestScore = score;
          bestEntry = entry;
        }
      }

      const fuseHits = fuseCatalog.search(spokenName);
      if (fuseHits.length > 0) {
        const fuseEntry = fuseHits[0].item;
        const fuseComposite = Math.max(
          computeCompositeDrugScore(spokenName, fuseEntry.canonicalName),
          ...fuseEntry.aliases.map((alias) => computeCompositeDrugScore(spokenName, alias))
        );
        if (fuseComposite > bestScore) {
          bestScore = fuseComposite;
          bestEntry = fuseEntry;
        }
      }

      if (bestEntry) {
        similarityScore = Number(bestScore.toFixed(2));
        allergyConflictReason = detectAllergyConflict(bestEntry, snapshot.knownAllergies);
        allergyConflictDetected = Boolean(allergyConflictReason);

        if (bestScore >= 0.80) {
          confidenceTier = 'HIGH';
          matchedCanonicalDrug = bestEntry.canonicalName;
          drugValidationStatus = allergyConflictDetected ? 'MISMATCH' : 'MATCH';
        } else if (bestScore >= 0.55) {
          confidenceTier = 'MEDIUM';
          matchedCanonicalDrug = bestEntry.canonicalName;
          drugValidationStatus = 'NEEDS_REVIEW';
          suggestedPrompt = `Needs Confirmation — Did you mean ${bestEntry.canonicalName}?`;
        } else {
          confidenceTier = 'LOW';
          matchedCanonicalDrug = null;
          allergyConflictDetected = false;
          allergyConflictReason = null;
          drugValidationStatus = 'UNKNOWN';
          suggestedPrompt = `[UNVERIFIED DRUG: "${spokenName}"] — do not substitute; manual clinician confirmation required.`;
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
        confidenceTier,
        suggestedPrompt,
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
