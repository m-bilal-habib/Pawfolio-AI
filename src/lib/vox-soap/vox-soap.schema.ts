// File: d:\Pawfolio AI\src\lib\vox-soap\vox-soap.schema.ts
import { z } from 'zod';

export const ObjectivePhysicalExamSchema = z.object({
  temperature: z.string().nullable().describe('Body temperature if explicitly spoken, else null'),
  heart_rate: z.string().nullable().describe('Heart rate if explicitly spoken, else null'),
  weight_kg: z.number().nullable().describe('Numeric weight in kg if explicitly spoken, else null'),
  respiratory_rate: z.string().nullable().describe('Respiratory rate if spoken, else null'),
  capillary_refill_time: z.string().nullable().describe('CRT if spoken, else null'),
  mucous_membranes: z.string().nullable().describe('Mucous membrane color/moistness if spoken, else null'),
  hydration_status: z.string().nullable().describe('Hydration status if spoken, else null'),
  body_condition_score: z.string().nullable().describe('BCS if spoken, else null'),
  pain_score: z.string().nullable().describe('Pain score if spoken, else null'),
  fear_anxiety_stress_score: z.string().nullable().describe('FAS score if spoken, else null'),
  eyes: z.string().nullable().describe('Ocular exam findings if spoken, else null'),
  ears: z.string().nullable().describe('Otic/ear canal findings if spoken, else null'),
  nasal: z.string().nullable().describe('Nasal findings if spoken, else null'),
  oral_dental: z.string().nullable().describe('Oral/dental findings if spoken, else null'),
  cardiovascular: z.string().nullable().describe('Cardiovascular findings if spoken, else null'),
  respiratory: z.string().nullable().describe('Pulmonary/respiratory findings if spoken, else null'),
  neurological: z.string().nullable().describe('Neurological findings if spoken, else null'),
  musculoskeletal: z.string().nullable().describe('Musculoskeletal findings if spoken, else null'),
  lymphatic: z.string().nullable().describe('Lymph nodes findings if spoken, else null'),
  gastrointestinal: z.string().nullable().describe('GI/abdominal findings if spoken, else null'),
  reproductive_urinary: z.string().nullable().describe('Urogenital findings if spoken, else null'),
  integument: z.string().nullable().describe('Skin/coat findings if spoken, else null'),
  masses: z.string().nullable().describe('Masses/lesions if spoken, else null'),
});

export const RawMedicationOrderSchema = z.object({
  medicine_name: z.string().nullable().describe('Medication name spoken by the vet, or null if missing'),
  dose_amount: z.string().nullable().describe('Exact dose e.g. "4 drops" or "16 mg", or null if not stated'),
  route: z.string().nullable().describe('Route e.g. "right ear", "oral", "topical", or null if not stated'),
  frequency: z.string().nullable().describe('Frequency e.g. "once a day", "twice daily", or null if not stated'),
  duration: z.string().nullable().describe('Duration e.g. "7 days", "14 days", or null if not stated'),
  start_date: z.string().nullable().describe('ISO date or relative start e.g. "today", or null'),
  owner_instructions: z.string().nullable().describe('Plain-language administration instructions spoken'),
  source_quote: z.string().min(1).describe('Verbatim substring from transcript proving this order'),
  extraction_confidence: z.number().min(0).max(1).describe('Confidence score between 0.0 and 1.0'),
});

export const GroundedSoapExtractionSchema = z.object({
  verbatim_transcript: z
    .string()
    .min(1)
    .describe('Complete verbatim transcript of the consultation conversation'),
  subjective: z.object({
    pet_name: z.string().nullable(),
    age_mentioned: z.string().nullable(),
    presenting_complaint: z.string().min(1),
    symptom_duration: z.string().nullable(),
    previous_medical_history: z.string().nullable(),
    source_quote: z.string().min(1),
  }),
  objective: ObjectivePhysicalExamSchema,
  assessment: z.object({
    diagnoses_and_findings: z.array(
      z.object({
        condition: z.string().min(1),
        clinical_reasoning: z.string().min(1),
        source_quote: z.string().min(1),
      })
    ),
    vaccination_status_notes: z.string().nullable(),
  }),
  plan: z.object({
    vaccinations_administered: z.array(z.string()),
    medication_orders: z.array(RawMedicationOrderSchema),
    test_orders: z.array(z.string()),
    follow_up_date_or_interval: z.string().nullable(),
    general_care_instructions: z.string().nullable(),
  }),
});

export type GroundedSoapExtractionOutput = z.infer<typeof GroundedSoapExtractionSchema>;
