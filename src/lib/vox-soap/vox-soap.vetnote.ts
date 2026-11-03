// File: d:\Pawfolio AI\src\lib\vox-soap\vox-soap.vetnote.ts

/**
 * Owner Fix 2 + Fix 3 (2026-11-01): the Scribenote-style veterinary note
 * contract produced by the LOCAL ml-serving /draft (format "vet_scribenote")
 * and the deterministic mappers that carry its sections into the main
 * VoxSOAP workspace cards.
 *
 * Two honest entry points:
 *   - `groundedFromVetSections()`: the ENGINE path — the ml-serving /draft
 *     response already ships the sectioned object (subjective paragraph,
 *     23-parameter objective map hydrated "Not mentioned", assessment/plan
 *     bullet strings), so the engine maps it straight onto
 *     GroundedSoapExtractionOutput; medication-order validation, weight
 *     cross-check and objective display all happen downstream in the
 *     engine pipeline exactly as for the Gemini path.
 *   - `groundedFromVetNoteText()`: the MLAssistPanel "Apply Draft to SOAP
 *     Workspace" path — the panel's reviewed draft is the FORMATTED text,
 *     so its headings are parsed with the SAME canonical rules as the
 *     server post-processing (case/punctuation-insensitive param matching,
 *     "Not mentioned" → null, deterministic bullet classification) and the
 *     applied cards match exactly what the veterinarian reviewed.
 *
 * No-hallucination rules: every value is taken from the note text; numbers
 * are only parsed when present; blanks stay null/Not mentioned — nothing is
 * invented. Unrecognized OBJECTIVE lines are never silently dropped in the
 * text path: they are returned so the caller can surface them verbatim.
 */
import type { GroundedSoapExtractionOutput } from './vox-soap.schema';

const NOT_MENTIONED = 'Not mentioned';

/** Model-emitted non-data placeholders (mirror of ml-serving/providers.py
 * `_VET_PLACEHOLDER_VALUES`): a bare "Normal"/"WNL"/"not examined"-style
 * value documents NOTHING, so it collapses deterministically to "Not
 * mentioned" — the canonical fill is the only not-documented representation
 * the frontend and the server hydration ever produce. */
const VET_PLACEHOLDER_TOKENS: ReadonlyArray<string> = [
  'not examined', 'not noted', 'not stated', 'not documented',
  'not mentioned', 'not evaluated', 'not assessed', 'not performed',
  'not recorded', 'not checked', 'unremarkable', 'unspecified',
  'no abnormality', 'no abnormality detected', 'no findings', 'no data',
  'nad', 'wnl', 'n/a', 'na', 'none', 'normal', 'within normal limits',
];
const VET_PLACEHOLDER_NORMS: ReadonlySet<string> = new Set(
  VET_PLACEHOLDER_TOKENS.map((token) => token.toLowerCase().replace(/[^a-z0-9/]/g, ''))
);

/** True when the whole value is a bare non-data placeholder. */
function isVetPlaceholderValue(value: string): boolean {
  return VET_PLACEHOLDER_NORMS.has(value.toLowerCase().replace(/[^a-z0-9/]/g, ''));
}

/** Canonical physical-exam parameter order (owner contract, never re-sorted)
 * paired with the GroundedSoapExtractionOutput objective keys. */
const VET_PARAM_KEYS: ReadonlyArray<readonly [param: string, key: string]> = [
  ['Temperature', 'temperature'],
  ['Heart Rate', 'heart_rate'],
  ['Weight', 'weight_kg'],
  ['Respiratory Rate', 'respiratory_rate'],
  ['Capillary Refill Time', 'capillary_refill_time'],
  ['Mucous Membranes', 'mucous_membranes'],
  ['Hydration Status', 'hydration_status'],
  ['Body Condition Score', 'body_condition_score'],
  ['Pain Score', 'pain_score'],
  ['Fear Anxiety Stress Score', 'fear_anxiety_stress_score'],
  ['Eyes', 'eyes'],
  ['Ears', 'ears'],
  ['Nasal', 'nasal'],
  ['Oral/Dental', 'oral_dental'],
  ['Cardiovascular', 'cardiovascular'],
  ['Respiratory', 'respiratory'],
  ['Neurological', 'neurological'],
  ['Musculoskeletal', 'musculoskeletal'],
  ['Lymphatic', 'lymphatic'],
  ['Gastrointestinal', 'gastrointestinal'],
  ['Reproductive/Urinary', 'reproductive_urinary'],
  ['Integument', 'integument'],
  ['Masses', 'masses'],
];

/** Case/punctuation-insensitive aliases the model may emit (mirrors
 * ml-serving/providers.py `_CANONICAL_KEY_LOOKUP`). Keys are normal forms. */
const VET_PARAM_ALIASES: Record<string, string> = {
  temp: 'Temperature',
  tempc: 'Temperature',
  hr: 'Heart Rate',
  pulse: 'Heart Rate',
  bw: 'Weight',
  bodyweight: 'Weight',
  rr: 'Respiratory Rate',
  resprate: 'Respiratory Rate',
  crt: 'Capillary Refill Time',
  capillaryrefill: 'Capillary Refill Time',
  mucous: 'Mucous Membranes',
  mm: 'Mucous Membranes',
  hydration: 'Hydration Status',
  bcs: 'Body Condition Score',
  bodycondition: 'Body Condition Score',
  pain: 'Pain Score',
  fas: 'Fear Anxiety Stress Score',
  fascore: 'Fear Anxiety Stress Score',
  fearanxietystress: 'Fear Anxiety Stress Score',
  eye: 'Eyes',
  ocular: 'Eyes',
  ear: 'Ears',
  earcanal: 'Ears',
  otoscopy: 'Ears',
  otoscopic: 'Ears',
  nose: 'Nasal',
  nasalcavity: 'Nasal',
  oral: 'Oral/Dental',
  dental: 'Oral/Dental',
  mouth: 'Oral/Dental',
  heart: 'Cardiovascular',
  cv: 'Cardiovascular',
  auscultation: 'Cardiovascular',
  lung: 'Respiratory',
  lungs: 'Respiratory',
  chest: 'Respiratory',
  neuro: 'Neurological',
  msk: 'Musculoskeletal',
  lymphnode: 'Lymphatic',
  lymphnodes: 'Lymphatic',
  gi: 'Gastrointestinal',
  abdomen: 'Gastrointestinal',
  abdominal: 'Gastrointestinal',
  reproductive: 'Reproductive/Urinary',
  urinary: 'Reproductive/Urinary',
  urogenital: 'Reproductive/Urinary',
  skin: 'Integument',
  coat: 'Integument',
  mass: 'Masses',
  lesion: 'Masses',
  lesions: 'Masses',
};

/** Underscore-dropping normal form shared by the HEADERS and param matching. */
function normalizeKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const KEY_TO_PARAM: Map<string, string> = new Map();
for (const [param] of VET_PARAM_KEYS) KEY_TO_PARAM.set(normalizeKey(param), param);
// Aliases overwrite canonical keys last — same precedence as the python
// dict.update so TS and server parses resolve identically.
for (const [alias, param] of Object.entries(VET_PARAM_ALIASES)) {
  KEY_TO_PARAM.set(normalizeKey(alias), param);
}

const VET_NOTE_HEADERS = new Set(['subjective', 'objectivementioned', 'objective', 'assessment', 'plan']);

function vetHeaderBucket(headNorm: string): 'subjective' | 'objective' | 'assessment' | 'plan' | null {
  if (headNorm === 'subjective') return 'subjective';
  if (headNorm === 'objective' || headNorm === 'objectivementioned') return 'objective';
  if (headNorm === 'assessment') return 'assessment';
  if (headNorm === 'plan') return 'plan';
  return null;
}

export interface VetNoteSections {
  subjective: string;
  objectiveMap: Record<string, string>;
  /** OBJECTIVE lines that matched NO canonical parameter — surfaced, not dropped. */
  objectiveUnknownLines: string[];
  assessmentBullets: string[];
  planBullets: string[];
}

/** Parse the FORMATTED vet-scribenote draft text (the MLAssistPanel's
 * reviewed draft state) into structured sections. Deterministic: matches the
 * four mandated headings case-insensitively, tolerates a missing colon and
 * in-line heading content, hydrates all 23 objective parameters, and keeps
 * every bullet line. When no heading matches at all the whole text is kept
 * as the subjective fallback (mirror of the server-side rule). */
export function splitVetNoteSections(draftText: string): VetNoteSections {
  const buckets: Record<'subjective' | 'objective' | 'assessment' | 'plan', string[]> = {
    subjective: [],
    objective: [],
    assessment: [],
    plan: [],
  };
  let current: 'subjective' | 'objective' | 'assessment' | 'plan' | null = null;
  for (const line of draftText.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped) continue;
    const colonIdx = stripped.indexOf(':');
    const head = colonIdx >= 0 ? stripped.slice(0, colonIdx) : stripped;
    const rest = colonIdx >= 0 ? stripped.slice(colonIdx + 1).trim() : '';
    const headNorm = normalizeKey(head);
    const bucket = VET_NOTE_HEADERS.has(headNorm) ? vetHeaderBucket(headNorm) : null;
    if (bucket) {
      current = bucket;
      if (rest) buckets[current].push(rest);
      continue;
    }
    if (current) buckets[current].push(stripped);
    // Pre-heading preamble is dropped (title noise), matching the server.
  }
  const foundAny = buckets.subjective.length + buckets.objective.length + buckets.assessment.length + buckets.plan.length > 0;
  if (!foundAny) buckets.subjective.push(draftText.trim());

  // Objective: key: value with continuation lines appended to the previous
  // canonical key; " - " is tolerated as a separator (server parity).
  const values = new Map<string, string>();
  const unknownLines: string[] = [];
  let currentParam: string | null = null;
  for (const line of buckets.objective) {
    let head = line;
    let value = '';
    let hadSeparator = false;
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      head = line.slice(0, colonIdx);
      value = line.slice(colonIdx + 1).trim();
      hadSeparator = true;
    } else {
      const dashIdx = line.search(/\s-\s/);
      if (dashIdx > 0) {
        head = line.slice(0, dashIdx);
        value = line.slice(dashIdx + 3).trim();
        hadSeparator = true;
      }
    }
    const canonical = hadSeparator ? KEY_TO_PARAM.get(normalizeKey(head)) : null;
    if (canonical) {
      let v = value;
      while (v.startsWith('-')) v = v.slice(1).trim();
      values.set(canonical, values.get(canonical) ? `${values.get(canonical)} ${v}`.trim() : v);
      currentParam = canonical;
      continue;
    }
    if (currentParam) {
      values.set(currentParam, `${values.get(currentParam)} ${line}`.trim());
      continue;
    }
    unknownLines.push(line);
  }
  const objectiveMap: Record<string, string> = {};
  for (const [param] of VET_PARAM_KEYS) {
    const v = (values.get(param) ?? '').trim();
    objectiveMap[param] =
      v && !isVetPlaceholderValue(v) ? v : NOT_MENTIONED;
  }

  const toBullets = (lines: string[]): string[] =>
    lines.map((l) => l.trim()).filter(Boolean).map((l) => (l.startsWith('-') ? l.slice(1).trim() : l)).filter(Boolean);

  return {
    subjective: buckets.subjective.join('\n').trim(),
    objectiveMap,
    objectiveUnknownLines: unknownLines,
    assessmentBullets: toBullets(buckets.assessment),
    planBullets: toBullets(buckets.plan),
  };
}

/* ---------- section → GroundedSoapExtractionOutput mapping ---------- */

const VACCINE_RE = /\b(vaccin\w*|dhpp|rabies|booster)/i;
const FOLLOW_UP_RE = /\b(recheck|follow[- ]?up|return)\b/i;
const TEST_ORDER_RE =
  /\b(blood|urine|cytology|culture|swab|x-?ray|radiograph(?:y)?|skin scrap\w*|fecal|scraper|ear cytolog\w*|test)\b/i;
const DOSE_RE =
  /(\d+(?:\.\d+)?)\s*(drops?|mg|mcg|ml|tablets?|tabs?|pumps?|capsules?|chews?)\b/i;
const FREQUENCY_RE =
  /\b(once daily|once a day|twice daily|twice a day|two times daily|three times daily|every\s+\d+\s*(?:hours?|hrs?)|q\.?\s*\d+\s*h|sid|bid|tid)\b/i;
const DURATION_RE = /\b(\d+)\s*(days?|weeks?|months?)\b/i;
const EAR_ROUTE_RE = /\b(right|left|both|each)\s+ears?\b/i;

const SECTION_UNAVAILABLE =
  'Manual review required — the vet-scribenote draft did not include this section.';

function parseWeightKg(value: string): number | null {
  const kgMatch = value.match(/(\d+(?:[.,]\d+)?)\s*kg/i);
  const numStr = kgMatch?.[1] ?? value.match(/(\d+(?:[.,]\d+)?)/)?.[1];
  if (!numStr) return null;
  const num = Number(numStr.replace(',', '.'));
  return Number.isFinite(num) ? num : null;
}

function extractAgeMentioned(paragraph: string): string | null {
  const m = paragraph.match(
    /\b(\d+(?:[.,]\d+)?)\s*(?:-|–|\s)+\s*(years?|yrs?|year|months?|mos?)\s*(?:old)?\b/i
  );
  if (!m) return null;
  const isYears = /^y/i.test(m[2]);
  return `${m[1].replace(',', '.')} ${isYears ? 'years' : 'months'} old`;
}

function extractSymptomDuration(paragraph: string): string | null {
  const m = paragraph.match(/\b(\d+)\s*(days?|weeks?|months?)\b/i);
  if (!m) return null;
  const unit = m[2].toLowerCase();
  return `${m[1]} ${unit.endsWith('s') ? unit : `${unit}s`}`;
}

function extractPastHistory(paragraph: string): string | null {
  const sentences = paragraph.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    if (/past (?:medical )?history|history of|previously treated|prior (?:medications|treatment)/i.test(sentence)) {
      return sentence.trim();
    }
  }
  return null;
}

function cleanValue(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return v && !isVetPlaceholderValue(v) ? v : null;
}

/** Coerce the envelope's objective_map/objective_text into the canonical
 * param→value map with all 23 entries present (missing → "Not mentioned"). */
function coerceObjectiveMap(sections: {
  objective_map?: unknown;
  objective_text?: unknown;
}): { map: Record<string, string>; unknownLines: string[] } {
  const values = new Map<string, string>();
  const unknownLines: string[] = [];
  const accept = (canonical: string, rawValue: unknown) => {
    const v = typeof rawValue === 'string' ? rawValue.trim() : '';
    let cleaned = v;
    while (cleaned.startsWith('-')) cleaned = cleaned.slice(1).trim();
    values.set(canonical, values.get(canonical) ? `${values.get(canonical)} ${cleaned}`.trim() : cleaned);
  };
  if (sections.objective_map && typeof sections.objective_map === 'object') {
    for (const [rawKey, rawValue] of Object.entries(sections.objective_map as Record<string, unknown>)) {
      const canonical = KEY_TO_PARAM.get(normalizeKey(rawKey));
      if (canonical) accept(canonical, rawValue);
      else {
        const asStr = typeof rawValue === 'string' ? rawValue.trim() : '';
        if (asStr) {
          // "Oral Dental: x" canonicalized above via normalize; a truly
          // unknown key still carries data — keep it attributable.
          unknownLines.push(`${rawKey}: ${asStr}`);
        }
      }
    }
  } else if (typeof sections.objective_text === 'string') {
    for (const line of (sections.objective_text as string).split(/\r?\n/)) {
      const stripped = line.trim();
      if (!stripped) continue;
      const colonIdx = stripped.indexOf(':');
      const canonical =
        colonIdx > 0 ? KEY_TO_PARAM.get(normalizeKey(stripped.slice(0, colonIdx))) : null;
      if (canonical) accept(canonical, stripped.slice(colonIdx + 1));
      else unknownLines.push(stripped);
    }
  }
  const map: Record<string, string> = {};
  for (const [param] of VET_PARAM_KEYS) {
    const raw = (values.get(param) ?? '').trim();
    map[param] = raw && !isVetPlaceholderValue(raw) ? raw : NOT_MENTIONED;
  }
  return { map, unknownLines };
}

function bulletToMedicationOrder(bullet: string): GroundedSoapExtractionOutput['plan']['medication_orders'][number] {
  const doseMatch = bullet.match(DOSE_RE);
  const freqMatch = bullet.match(FREQUENCY_RE);
  const durationMatch = bullet.match(DURATION_RE);
  const earRouteMatch = bullet.match(EAR_ROUTE_RE);
  const startMatch = bullet.match(/\b(today|tonight|tomorrow)\b/i);
  let medicineName: string | null = null;
  const colonIdx = bullet.indexOf(':');
  if (colonIdx > 0 && colonIdx <= 60) medicineName = bullet.slice(0, colonIdx).trim() || null;
  let route: string | null = null;
  if (earRouteMatch) {
    route = `${earRouteMatch[1].toLowerCase()} ear`;
  } else if (/\borally?\b|by mouth/i.test(bullet)) {
    route = 'oral';
  } else if (/\btopical(?:ly)?\b/i.test(bullet)) {
    route = 'topical';
  } else if (/\bophthalmic\b|both eyes?\b/i.test(bullet)) {
    route = 'ophthalmic';
  }
  return {
    medicine_name: medicineName,
    dose_amount: doseMatch
      ? `${doseMatch[1]} ${doseMatch[2].toLowerCase()}`.replace('drops', 'drops').replace('tablets', 'tablets').replace('capsules', 'capsules')
      : null,
    route,
    frequency: freqMatch ? freqMatch[1].toLowerCase() : null,
    duration: durationMatch
      ? `${durationMatch[1]} ${durationMatch[2].toLowerCase().endsWith('s') ? durationMatch[2].toLowerCase() : `${durationMatch[2].toLowerCase()}s`}`
      : null,
    start_date: startMatch ? startMatch[1].toLowerCase() : null,
    owner_instructions: bullet,
    source_quote: bullet,
    extraction_confidence: doseMatch ? 0.85 : 0.5,
  };
}

/** Map the ml-serving /draft vet_scribenote sections (or the panel-parsed
 * text sections) onto GroundedSoapExtractionOutput. Deterministic + honest:
 * nulls stay null; source quotes are the model's own statements; nothing is
 * invented for blanks. */
export function groundedFromVetSections(
  sections: {
    subjective?: unknown;
    objective_map?: unknown;
    objective_text?: unknown;
    assessment?: unknown;
    plan?: unknown;
  } | null | undefined,
  transcript: string
): GroundedSoapExtractionOutput {
  const s = sections ?? {};
  const subjectiveRaw = typeof s.subjective === 'string' ? s.subjective.trim() : '';
  const assessmentText = typeof s.assessment === 'string' ? s.assessment : '';
  const planText = typeof s.plan === 'string' ? s.plan : '';
  const coerced = coerceObjectiveMap(s);

  const verbatim = transcript.trim() || subjectiveRaw || SECTION_UNAVAILABLE;

  // Objective: "Not mentioned" → null (the workspace renders its own label);
  // Weight parses into the numeric weight_kg the schema demands.
  const objective = {} as GroundedSoapExtractionOutput['objective'];
  for (const [param, key] of VET_PARAM_KEYS) {
    const value = cleanValue(coerced.map[param]);
    if (key === 'weight_kg') {
      (objective as Record<string, unknown>)[key] = value ? parseWeightKg(value) : null;
    } else {
      (objective as Record<string, unknown>)[key] = value;
    }
  }

  const planBullets = planText.trim() ? planText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  const vaccinations: string[] = [];
  const testOrders: string[] = [];
  const medOrders: GroundedSoapExtractionOutput['plan']['medication_orders'] = [];
  let followUp: string | null = null;
  const generalCare: string[] = [];
  for (const bullet of planBullets) {
    const body = bullet.startsWith('-') ? bullet.slice(1).trim() : bullet;
    if (!body) continue;
    if (VACCINE_RE.test(body)) {
      vaccinations.push(body);
    } else if (!followUp && FOLLOW_UP_RE.test(body) && !DOSE_RE.test(body)) {
      followUp = body;
    } else if (DOSE_RE.test(body)) {
      medOrders.push(bulletToMedicationOrder(body));
    } else if (TEST_ORDER_RE.test(body)) {
      testOrders.push(body);
    } else {
      generalCare.push(body);
    }
  }

  const assessmentBullets = assessmentText.trim()
    ? assessmentText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    : [];
  const diagnoses: GroundedSoapExtractionOutput['assessment']['diagnoses_and_findings'] = [];
  let vaccinationNotes: string | null = null;
  for (const bullet of assessmentBullets) {
    const body = bullet.startsWith('-') ? bullet.slice(1).trim() : bullet;
    if (!body) continue;
    if (!vaccinationNotes && VACCINE_RE.test(body)) {
      vaccinationNotes = body;
      continue;
    }
    const splitMatch = body.match(/[,:;]\s*/);
    const condition = splitMatch ? body.slice(0, splitMatch.index).trim() : body;
    const clinicalReasoning = splitMatch && body.slice((splitMatch.index ?? 0) + splitMatch[0].length).trim();
    diagnoses.push({
      condition: condition || body,
      clinical_reasoning: clinicalReasoning || body,
      source_quote: body,
    });
  }

  return {
    verbatim_transcript: verbatim,
    subjective: {
      // Honest traceable fields harvested from the subjective paragraph:
      // ONLY strings the paragraph itself contains, else null.
      pet_name: null,
      age_mentioned: subjectiveRaw ? extractAgeMentioned(subjectiveRaw) : null,
      presenting_complaint: subjectiveRaw || SECTION_UNAVAILABLE,
      symptom_duration: subjectiveRaw ? extractSymptomDuration(subjectiveRaw) : null,
      previous_medical_history: subjectiveRaw ? extractPastHistory(subjectiveRaw) : null,
      // Full transcript preserved — no truncation anywhere (owner Fix 3).
      source_quote: verbatim,
    },
    objective,
    assessment: {
      diagnoses_and_findings: diagnoses,
      vaccination_status_notes: vaccinationNotes,
    },
    plan: {
      vaccinations_administered: vaccinations,
      medication_orders: medOrders,
      test_orders: testOrders,
      follow_up_date_or_interval: followUp,
      general_care_instructions: generalCare.length ? generalCare.join(' ') : null,
    },
  };
}

/** Text entry point for the MLAssistPanel Apply button: returns the mapped
 * output PLUS the unrecognized objective lines so the caller can surface
 * them verbatim instead of dropping them. */
export function groundedFromVetNoteText(
  draftText: string,
  transcript: string
): { output: GroundedSoapExtractionOutput; objectiveUnknownLines: string[]; objectiveMap: Record<string, string> } {
  const sections = splitVetNoteSections(draftText);
  const output = groundedFromVetSections(
    {
      subjective: sections.subjective,
      objective_map: sections.objectiveMap,
      assessment: sections.assessmentBullets.map((b) => `- ${b}`).join('\n'),
      plan: sections.planBullets.map((b) => `- ${b}`).join('\n'),
    },
    transcript
  );
  return {
    output,
    objectiveUnknownLines: sections.objectiveUnknownLines,
    objectiveMap: sections.objectiveMap,
  };
}
