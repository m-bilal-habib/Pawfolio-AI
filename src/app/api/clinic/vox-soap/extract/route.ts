// File: d:\Pawfolio AI\src\app\api\clinic\vox-soap\extract\route.ts
import { NextRequest, NextResponse } from 'next/server';
import { resolveTranscribeProvider, voxSoapEngine } from '@/lib/vox-soap/vox-soap.engine';
import { voxSoapStore } from '@/lib/vox-soap/vox-soap.catalog';
import { ClinicStaffRole, StaffSessionContext } from '@/lib/vox-soap/vox-soap.types';

// Mirrors the audio formats Google Gemini can transcribe + the browser
// MediaRecorder containers. Kept in sync with PANEL client whitelist in
// src/components/vox-soap/UploadAudioPanel.tsx.
const ALLOWED_AUDIO_MIMES = new Set([
  'audio/webm',
  'audio/mp4', // m4a / Safari MediaRecorder fallback
  'audio/x-m4a', // Chrome reports .m4a as x-m4a
  'audio/mp3',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/opus',
  'audio/aac',
  'audio/flac',
  'audio/x-flac',
  'audio/aiff',
  'audio/x-aiff',
]);

/**
 * Browsers and OS registries rarely report a bare MIME: MediaRecorder emits
 * "audio/webm;codecs=opus", Windows WAVE files surface as "audio/wave" or
 * "audio/vnd.wave". The allowlist comparison always sees the NORMALIZED base
 * type, never the raw string (2026-10-31 E2E fix: the raw
 * "audio/webm;codecs=opus" tag was rejected 415 at stop-recording).
 */
function normalizeAudioMime(rawMime: string): string {
  const base = rawMime.split(';')[0].trim().toLowerCase();
  return base === 'audio/wave' || base === 'audio/vnd.wave' ? 'audio/wav' : base;
}

/** Extension fallback for files whose reported type carries no information
 * (empty File.type or generic application/octet-stream — common on Windows
 * for .m4a/.aac/.flac recordings whose registry mapping is missing). Every
 * value is a member of ALLOWED_AUDIO_MIMES. */
const EXTENSION_TO_MIME: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mp3',
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  mp4: 'audio/mp4',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
};

/** Resolves what an uploaded audio File actually is: strip parameters from
 * the reported type first; only when the type says nothing (empty or the
 * generic octet-stream bucket) trust the file extension. */
function resolveUploadAudioMime(file: File): { mime: string | null; reported: string } {
  const reported = normalizeAudioMime(file.type);
  if (ALLOWED_AUDIO_MIMES.has(reported)) return { mime: reported, reported };
  const fileExt = (file.name.split('.').pop() ?? '').toLowerCase();
  if ((reported === '' || reported === 'application/octet-stream') && fileExt in EXTENSION_TO_MIME) {
    const byExt = EXTENSION_TO_MIME[fileExt];
    return { mime: byExt, reported };
  }
  return { mime: null, reported };
}

function extractStaffSession(req: NextRequest): StaffSessionContext {
  const roleHeader = (req.headers.get('x-staff-role') ?? 'veterinarian') as ClinicStaffRole;
  return {
    userId: req.headers.get('x-staff-id') ?? 'vet-ali-001',
    fullName: req.headers.get('x-staff-name') ?? 'Dr. Ali',
    clinicId: req.headers.get('x-clinic-id') ?? 'clinic-lhr-01',
    role: ['veterinarian', 'assistant', 'receptionist', 'admin'].includes(roleHeader)
      ? roleHeader
      : 'veterinarian',
  };
}

export async function POST(req: NextRequest) {
  try {
    const staff = extractStaffSession(req);
    if (staff.role === 'receptionist') {
      return NextResponse.json(
        { error: 'Forbidden (FR-6): Receptionists cannot initiate clinical SOAP dictation.' },
        { status: 403 }
      );
    }

    // NFR-6: Idempotency protection
    const idempotencyKey = req.headers.get('x-idempotency-key');
    if (idempotencyKey) {
      const existingVisitId = voxSoapStore.getIdempotentVisitId(idempotencyKey);
      if (existingVisitId) {
        const cachedVisit = voxSoapStore.getVisit(existingVisitId);
        if (cachedVisit) {
          return NextResponse.json({ idempotentReplay: true, visit: cachedVisit }, { status: 200 });
        }
      }
    }

    const contentType = req.headers.get('content-type') ?? '';
    let petId = 'pet-leo-001';
    let transcriptText: string | undefined;
    let audioBuffer: Buffer | undefined;
    let audioMimeType: string | undefined;
    let recordingId: string | undefined;
    let consentAt: string | undefined;
    // Local-first routing knobs (2026-10-31): language tags the Whisper
    // decoder ('ur' default — the original scaffold behaviour); the provider
    // override falls through to VOXSOAP_TRANSCRIBE_PROVIDER / default 'ml'
    // when the field is absent.
    let language: 'ur' | 'en' | 'auto' = 'ur';
    let transcribeProvider: string | undefined;

    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData();
      petId = String(formData.get('petId') ?? 'pet-leo-001');
      const rawTranscriptField = formData.get('transcript');
      if (typeof rawTranscriptField === 'string' && rawTranscriptField.trim()) {
        transcriptText = rawTranscriptField.trim();
      }
      const rawRecordingId = formData.get('recordingId');
      if (typeof rawRecordingId === 'string' && rawRecordingId.trim()) {
        recordingId = rawRecordingId.trim();
      }
      const rawConsentAt = formData.get('consentAt');
      if (typeof rawConsentAt === 'string' && rawConsentAt.trim()) {
        consentAt = rawConsentAt.trim();
      }
      const rawLanguage = formData.get('language');
      if (typeof rawLanguage === 'string' && rawLanguage.trim()) {
        language = rawLanguage.trim().toLowerCase() as 'ur' | 'en' | 'auto';
      }
      const rawTranscribeProvider = formData.get('transcribeProvider');
      if (typeof rawTranscribeProvider === 'string' && rawTranscribeProvider.trim()) {
        transcribeProvider = rawTranscribeProvider.trim().toLowerCase();
      }

      const audioFile = formData.get('audio');
      if (audioFile instanceof File) {
        const maxBytes = Number(process.env.VOX_SOAP_MAX_AUDIO_MB ?? 25) * 1024 * 1024;
        if (audioFile.size > maxBytes) {
          return NextResponse.json(
            { error: `Audio file exceeds maximum allowed size (${maxBytes} bytes).` },
            { status: 413 }
          );
        }
        const resolved = resolveUploadAudioMime(audioFile);
        if (!resolved.mime) {
          return NextResponse.json(
            {
              error: `Unsupported audio MIME type: ${resolved.reported || '(empty)'} — accepted audio: WebM, WAV, MP3, M4A, AAC, OGG, FLAC, AIFF.`,
            },
            { status: 415 }
          );
        }
        audioBuffer = Buffer.from(await audioFile.arrayBuffer());
        audioMimeType = resolved.mime;
      }
    } else {
      const body = await req.json();
      petId = body.petId ?? 'pet-leo-001';
      transcriptText = body.transcript;
      if (typeof body.recordingId === 'string' && body.recordingId.trim()) {
        recordingId = body.recordingId.trim();
      }
      if (typeof body.consentAt === 'string' && body.consentAt.trim()) {
        consentAt = body.consentAt.trim();
      }
      if (typeof body.language === 'string' && body.language.trim()) {
        language = body.language.trim().toLowerCase() as 'ur' | 'en' | 'auto';
      }
      if (typeof body.transcribeProvider === 'string' && body.transcribeProvider.trim()) {
        transcribeProvider = body.transcribeProvider.trim().toLowerCase();
      }
    }

    // Honest 400s BEFORE any model work — mirrors the ml-serving gates:
    // unsupported values are request errors, never silent clamps.
    if (language !== 'ur' && language !== 'en' && language !== 'auto') {
      return NextResponse.json(
        { error: `unsupported language ${language}; allowed: ur | en | auto` },
        { status: 400 }
      );
    }
    let resolvedProvider: 'ml' | 'gemini';
    try {
      resolvedProvider = resolveTranscribeProvider(transcribeProvider);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 400 }
      );
    }
    // Local-ml audio contract (2026-10-31): the CLIENT must deliver 16 kHz
    // mono PCM WAV — the ml-serving server never resamples, because a
    // misread rate would corrupt ASR output. Anything else is an honest 415
    // before any model work.
    if (
      resolvedProvider === 'ml' &&
      audioBuffer &&
      normalizeAudioMime(audioMimeType ?? '') !== 'audio/wav'
    ) {
      return NextResponse.json(
        {
          error:
            `Local-ML transcription requires the 16 kHz mono PCM WAV contract — got '${audioMimeType}'. ` +
            'The panels deliver WAV client-side (decodeAndResampleToWav16k / startPcm16Capture); the ml-serving server never resamples.',
        },
        { status: 415 }
      );
    }

    if (!audioBuffer && (!transcriptText || transcriptText.trim().length < 10)) {
      return NextResponse.json(
        { error: 'Provide either a valid consultation audio file or a transcript string.' },
        { status: 400 }
      );
    }

    // Scribenote pattern: audio UPLOADS that carry a recording shell run in the
    // background — the response returns immediately with the shell's visitId
    // (status 'Transcribing') and the client polls /state?visitId=…. On a
    // failed attempt the client presses "↻ Retry transcription", which re-sends
    // the SAME file against the SAME visit — no re-recording, no new shells.
    const shellVisit = recordingId ? voxSoapStore.getVisit(recordingId) : undefined;
    if (shellVisit && audioBuffer) {
      const queued = voxSoapEngine.queueGroundedSoapExtraction({
        petId,
        staff,
        audioBuffer,
        audioMimeType,
        recordingId,
        consentAt,
        transcribeProvider: resolvedProvider,
        asrLanguage: language,
      });
      if (queued.alreadyQueued) {
        return NextResponse.json(
          {
            visitId: queued.visitId,
            workflowStatus: 'Transcribing',
            alreadyQueued: true,
          },
          { status: 200 }
        );
      }
      return NextResponse.json(
        {
          visitId: queued.visitId,
          workflowStatus: 'Transcribing',
          attempt: queued.attempt,
          queued: true,
        },
        { status: 202 }
      );
    }

    const draftVisit = await voxSoapEngine.extractGroundedSoapDraft({
      petId,
      staff,
      audioBuffer,
      audioMimeType,
      transcriptText,
      recordingId,
      consentAt,
      transcribeProvider: resolvedProvider,
      asrLanguage: language,
    });

    if (idempotencyKey) {
      voxSoapStore.setIdempotentVisitId(idempotencyKey, draftVisit.visitId);
    }

    return NextResponse.json({ idempotentReplay: false, visit: draftVisit }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'VoxSOAP extraction error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
