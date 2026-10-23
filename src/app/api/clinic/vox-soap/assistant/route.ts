// File: d:\Pawfolio AI\src\app\api\clinic\vox-soap\assistant\route.ts
import { NextRequest, NextResponse } from 'next/server';
import {
  voxSoapEngine,
  WritingAssistantOptions,
} from '@/lib/vox-soap/vox-soap.engine';
import { voxSoapStore } from '@/lib/vox-soap/vox-soap.catalog';
import { extractStaffSession } from '@/lib/vox-soap/vox-soap.workflow';

/**
 * Scribenote-parity "Trigger Writing Assistant" endpoint (web edit view).
 * Rewrites a SOAP section's text per combinable style settings. Uses the same
 * quota-safe serialized Gemini channel as extraction (model chain, 429
 * cooldown, 503 backoff) and records an immutable audit event per application.
 */

const FORMAT_VALUES = ['bullet', 'paragraph', 'subheadings', ''];
const TERMINOLOGY_VALUES = ['medical', 'laymans', ''];
const ABBREV_VALUES = ['abbreviated', 'full', ''];
const LANGUAGE_VALUES = ['English', 'French', 'Spanish', 'Portuguese', 'German', ''];

function normalizeOptions(raw: Partial<WritingAssistantOptions> | undefined): WritingAssistantOptions {
  const o: WritingAssistantOptions = {
    format: null,
    terminology: null,
    abbreviations: null,
    language: null,
  };
  if (raw) {
    if (typeof raw.format === 'string' && FORMAT_VALUES.includes(raw.format)) {
      o.format = (raw.format || null) as WritingAssistantOptions['format'];
    }
    if (typeof raw.terminology === 'string' && TERMINOLOGY_VALUES.includes(raw.terminology)) {
      o.terminology = (raw.terminology || null) as WritingAssistantOptions['terminology'];
    }
    if (
      typeof raw.abbreviations === 'string' &&
      ABBREV_VALUES.includes(raw.abbreviations)
    ) {
      o.abbreviations = (raw.abbreviations || null) as WritingAssistantOptions['abbreviations'];
    }
    if (typeof raw.language === 'string' && LANGUAGE_VALUES.includes(raw.language)) {
      o.language = (raw.language || null) as WritingAssistantOptions['language'];
    }
  }
  return o;
}

export async function POST(req: NextRequest) {
  try {
    const staff = extractStaffSession(req);
    const body = (await req.json()) as {
      text?: string;
      sectionLabel?: string;
      options?: Partial<WritingAssistantOptions>;
      visitId?: string;
    };

    const text = String(body.text ?? '');
    if (!text.trim()) {
      return NextResponse.json(
        { error: 'Nothing to rewrite — the section text is empty.' },
        { status: 400 }
      );
    }
    if (text.length > 12000) {
      return NextResponse.json(
        { error: 'Section text is too long for the Writing Assistant (12,000 character limit).' },
        { status: 413 }
      );
    }
    if (staff.role === 'receptionist') {
      return NextResponse.json(
        { error: 'Receptionists cannot run the Writing Assistant on clinical notes (FR-6).' },
        { status: 403 }
      );
    }

    const sectionLabel = String(body.sectionLabel ?? 'SOAP section').slice(0, 40);
    const options = normalizeOptions(body.options);

    const result = await voxSoapEngine.runWritingAssistant({
      text,
      sectionLabel,
      options,
    });

    // Immutable provenance: record which clinician applied assistant text
    // to which visit/section (mirrors Scribenote's note edit provenance).
    if (body.visitId) {
      const visit = voxSoapStore.getVisit(body.visitId);
      if (visit) {
        voxSoapStore.recordAudit({
          clinicId: staff.clinicId,
          actorId: staff.userId,
          actorRole: staff.role,
          petId: visit.petId,
          visitId: visit.visitId,
          action: 'WRITING_ASSISTANT_APPLIED',
          previousState: visit.recordState,
          newState: visit.recordState,
          metadata: {
            sectionLabel,
            options,
            aiModel: result.assistantModel,
          },
        });
      }
    }

    return NextResponse.json({ result: result.text, assistantModel: result.assistantModel });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'The Writing Assistant is unavailable right now.',
      },
      { status: 503 }
    );
  }
}
