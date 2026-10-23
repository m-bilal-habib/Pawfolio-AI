// File: d:\Pawfolio AI\src\app\api\clinic\vox-soap\extract\route.ts
import { NextRequest, NextResponse } from 'next/server';
import { voxSoapEngine } from '@/lib/vox-soap/vox-soap.engine';
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

      const audioFile = formData.get('audio');
      if (audioFile instanceof File) {
        const maxBytes = Number(process.env.VOX_SOAP_MAX_AUDIO_MB ?? 25) * 1024 * 1024;
        if (audioFile.size > maxBytes) {
          return NextResponse.json(
            { error: `Audio file exceeds maximum allowed size (${maxBytes} bytes).` },
            { status: 413 }
          );
        }
        if (!ALLOWED_AUDIO_MIMES.has(audioFile.type)) {
          return NextResponse.json(
            { error: `Unsupported audio MIME type: ${audioFile.type}` },
            { status: 415 }
          );
        }
        audioBuffer = Buffer.from(await audioFile.arrayBuffer());
        audioMimeType = audioFile.type;
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
