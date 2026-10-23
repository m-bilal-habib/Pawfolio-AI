// File: d:\Pawfolio AI\src\components\vox-soap\UploadAudioPanel.tsx
'use client';

import React, { useEffect, useRef, useState } from 'react';
import { PANEL_THEME, type PanelAccent } from './NewRecordingPanel';
import { aiErrorSummaryFromAudit } from '@/lib/vox-soap/vox-soap.aierrors';
import type { VoxSoapVisitRecord } from '@/lib/vox-soap/vox-soap.types';

/**
 * Scribenote-parity "Upload audio" panel (web-only upload path).
 *
 * The same never-hallucinate rules apply to uploaded consultations as to live
 * recordings:
 *   - Client-side validation mirrors the server exactly (NFR-3 / extract route):
 *     MIME whitelist audio/webm · wav · x-wav · mp3 · mpeg · ogg, 25 MB cap —
 *     rejected files NEVER reach the API and never generate a draft.
 *   - Mandatory client-consent strip; the consent timestamp is stored on the
 *     record (audit provenance) exactly like live recordings.
 *   - Status line is honest: TRANSCRIBING while the Gemini extraction runs,
 *     AVAILABLE FOR REVIEW on success — nothing is invented for bad files.
 *   - Duration is probed locally for display only (some webm blobs report
 *     Infinity — shown as "—" rather than a guessed number).
 */

/**
 * Scribenote-pattern stages:
 *   idle         — file picked, nothing sent yet
 *   uploading    — shell + extract POSTs in flight (fast)
 *   transcribing — background AI worker running; the client POLLs /state
 *   done         — AI draft ready (Available for Review)
 *   failed       — extraction could not produce an AI draft; "↻ Retry
 *                  transcription" re-sends the SAME file against the SAME
 *                  visit (no re-recording, no re-picking)
 *   error        — HTTP-level rejection before/at job submission
 */
export type UploadStage =
  | 'idle'
  | 'uploading'
  | 'transcribing'
  | 'done'
  | 'error'
  | 'failed';

/** Mirrors ALLOWED_AUDIO_MIMES in src/app/api/clinic/vox-soap/extract/route.ts */
const ALLOWED_MIMES = new Set([
  'audio/webm',
  'audio/mp4',
  'audio/x-m4a',
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
 * Fallback for browsers that report an empty File.type (common for .m4a
 * voice memos, .opus, .oga). Checked by extension.
 */
const EXTENSION_FALLBACK: Record<string, string> = {
  webm: 'audio/webm',
  wav: 'audio/wav',
  mp3: 'audio/mp3',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
};

/** Resolves a candidate file's real MIME type (File.type first, then extension). */
function resolveAudioMime(file: File): string | null {
  const byType = file.type.toLowerCase();
  if (byType && ALLOWED_MIMES.has(byType)) return byType;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const byExt = EXTENSION_FALLBACK[ext];
  if (byExt && ALLOWED_MIMES.has(byExt)) return byExt;
  return null;
}

const MAX_BYTES = 25 * 1024 * 1024; // VOX_SOAP_MAX_AUDIO_MB default (server 413 guard)

export const UploadAudioPanel: React.FC<{
  open: boolean;
  defaultPetId: string;
  staffRole: string;
  staffId: string;
  staffName: string;
  accent?: PanelAccent;
  contextLabel?: string;
  onClose: () => void;
  onCompleted: (visit: VoxSoapVisitRecord) => void;
}> = ({
  open,
  defaultPetId,
  staffRole,
  staffId,
  staffName,
  accent = 'indigo',
  contextLabel = 'Upload • demo patient Leo',
  onClose,
  onCompleted,
}) => {
  const [stage, setStage] = useState<UploadStage>('idle');
  const [file, setFile] = useState<File | null>(null);
  const [durationSeconds, setDurationSeconds] = useState<number | null>(null);
  const [consentChecked, setConsentChecked] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'warn' | 'error'; text: string } | null>(null);
  const [lastAiError, setLastAiError] = useState<string | null>(null);
  const [elapsedLabel, setElapsedLabel] = useState('0:00');

  // Scribenote-pattern job bookkeeping: the shell visitId is created ONCE and
  // reused by every retry, so version history keeps ONE row for this audio.
  const recordingIdRef = useRef<string | null>(null);
  const consentAtRef = useRef<string | null>(null);
  const pollRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(0);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const t = PANEL_THEME[accent];

  const stopPolling = () => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const resetFile = () => {
    stopPolling();
    recordingIdRef.current = null;
    consentAtRef.current = null;
    setFile(null);
    setDurationSeconds(null);
    setNotice(null);
    setLastAiError(null);
    setStage('idle');
  };

  // Never leak a poller across mounts (StrictMode double-mount safe).
  useEffect(() => () => stopPolling(), []);

  /** Validates a candidate file, then probes its duration for display. */
  const acceptFile = (candidate: File) => {
    setNotice(null);
    const resolvedType = resolveAudioMime(candidate);
    if (!resolvedType) {
      setStage('idle');
      setFile(null);
      setNotice({
        tone: 'error',
        text: `Unsupported format ("${candidate.name.split('.').pop() ?? 'unknown'}"). Accepted audio: WebM, WAV, MP3, M4A, AAC, OGG, FLAC, AIFF.`,
      });
      return;
    }
    if (candidate.size > MAX_BYTES) {
      setStage('idle');
      setFile(null);
      setNotice({
        tone: 'error',
        text: `This file is ${(candidate.size / (1024 * 1024)).toFixed(1)} MB — the server accepts at most 25 MB (NFR-3, HTTP 413). Trim or compress it first.`,
      });
      return;
    }
    setFile(candidate);
    setDurationSeconds(null);
    setStage('idle');
    // Display-only duration probe (never blocks upload; webm blobs may report
    // Infinity in Chrome — shown as "—", not guessed).
    try {
      const objectUrl = URL.createObjectURL(candidate);
      const probe = new Audio();
      probe.preload = 'metadata';
      probe.onloadedmetadata = () => {
        URL.revokeObjectURL(objectUrl);
        setDurationSeconds(Number.isFinite(probe.duration) ? probe.duration : null);
      };
      probe.onerror = () => URL.revokeObjectURL(objectUrl);
      probe.src = objectUrl;
    } catch {
      // Probe failure is cosmetic — upload still works.
    }
  };

  const handlePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    if (picked) acceptFile(picked);
    e.target.value = ''; // allow re-selecting the same file after a fix
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    if (stage !== 'idle') return;
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) acceptFile(dropped);
  };

  const finishExtraction = (visit: VoxSoapVisitRecord) => {
    stopPolling();
    if (visit.sourceType === 'Manual_Fallback_Draft') {
      // Honest failure — the client still holds the exact file, so the retry
      // button can re-send it without re-recording (see retryTranscription).
      setStage('failed');
      return;
    }
    setStage('done');
    setTimeout(() => {
      stopPolling();
      recordingIdRef.current = null;
      consentAtRef.current = null;
      setFile(null);
      setDurationSeconds(null);
      setNotice(null);
      setLastAiError(null);
      setConsentChecked(false);
      onClose();
      onCompleted(visit);
    }, 700);
  };

  const pollTranscription = async (visitId: string) => {
    const elapsedSec = Math.floor((Date.now() - startedAtRef.current) / 1000);
    setElapsedLabel(`${Math.floor(elapsedSec / 60)}:${String(elapsedSec % 60).padStart(2, '0')}`);
    try {
      const res = await fetch(
        `/api/clinic/vox-soap/state?petId=${encodeURIComponent(
          defaultPetId
        )}&visitId=${encodeURIComponent(visitId)}`,
        {
          headers: {
            'x-staff-role': staffRole,
            'x-staff-id': staffId,
            'x-staff-name': staffName,
            'x-clinic-id': 'clinic-lhr-01',
          },
        }
      );
      if (!res.ok) return; // transient server hiccup — keep waiting
      const payload = (await res.json()) as {
        visits?: VoxSoapVisitRecord[];
        auditTrail?: Array<{ metadata?: Record<string, unknown> }>;
      };
      const visit = (payload.visits ?? []).find((v) => v.visitId === visitId);
      if (!visit) return; // not yet persisted — keep waiting
      if (visit.workflowStatus === 'Unsynced' || visit.workflowStatus === 'Transcribing') {
        // The engine's budget is 4 minutes baked in; past 8 minutes the job
        // was interrupted (e.g. dev-server restart) — surface honestly.
        if (elapsedSec > 8 * 60) {
          stopPolling();
          setLastAiError(
            'The transcription job did not report back in 8 minutes (it may have been interrupted by a server restart).'
          );
          setStage('failed');
        }
        return;
      }
      setLastAiError(aiErrorSummaryFromAudit(payload.auditTrail));
      finishExtraction(visit);
    } catch {
      // Network blip — the next tick keeps polling within the budget.
    }
  };

  /** Posts the shell (once) + extract, then switches to polling. Shared by
   * the initial submit AND every "↻ Retry transcription" press. */
  const postTranscriptionJob = async () => {
    if (!file) return;
    setNotice(null);
    setLastAiError(null);
    try {
      // Re-wrap with the RESOLVED MIME type: some browsers report File.type=''
      // for .m4a/.opus files, which would fail the server-side 415 whitelist
      // even though the audio itself is perfectly decodable.
      const resolved = resolveAudioMime(file) ?? 'audio/webm';
      const normalizedName = file.name || `consultation-upload.${resolved.split('/')[1]}`;
      const typedFile =
        file.type === resolved ? file : new File([file], normalizedName, { type: resolved });

      // 1) Scribenote shell — created ONCE per audio file (NOT per attempt) so
      // retries keep the same visitId and version history stays clean.
      if (!recordingIdRef.current) {
        try {
          const shellRes = await fetch('/api/clinic/vox-soap/recordings', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-staff-role': staffRole,
              'x-staff-id': staffId,
              'x-staff-name': staffName,
              'x-clinic-id': 'clinic-lhr-01',
            },
            body: JSON.stringify({ petId: defaultPetId, consentAt: consentAtRef.current }),
          });
          if (shellRes.ok) {
            const shellPayload = (await shellRes.json()) as { recordingId?: string };
            recordingIdRef.current = shellPayload.recordingId ?? null;
          }
        } catch {
          // Shell optional — the extract route then falls back to the
          // synchronous path (full visit returned in one response).
        }
      }

      // 2) Queue the transcription — the route answers immediately (HTTP 202)
      // with the visitId; Gemini work continues in the background.
      const formData = new FormData();
      formData.append('petId', defaultPetId);
      if (recordingIdRef.current) formData.append('recordingId', recordingIdRef.current);
      if (consentAtRef.current) formData.append('consentAt', consentAtRef.current);
      formData.append('audio', typedFile, normalizedName);

      const res = await fetch('/api/clinic/vox-soap/extract', {
        method: 'POST',
        headers: {
          'x-staff-role': staffRole,
          'x-staff-id': staffId,
          'x-staff-name': staffName,
          'x-clinic-id': 'clinic-lhr-01',
        },
        body: formData,
      });
      const payload = (await res.json()) as {
        error?: string;
        visit?: VoxSoapVisitRecord;
        visitId?: string;
      };
      if (!res.ok) {
        setStage('error');
        setNotice({
          tone: 'error',
          text: payload.error ?? `Extraction blocked (HTTP ${res.status}).`,
        });
        return;
      }

      // Legacy synchronous reply carries the finished visit directly.
      if (payload.visit) {
        finishExtraction(payload.visit);
        return;
      }

      // Async Scribenote reply: poll /state until the visit leaves
      // 'Transcribing' (success draft or honest fallback).
      const visitId = String(payload.visitId ?? recordingIdRef.current ?? '');
      startedAtRef.current = Date.now();
      setStage('transcribing');
      setElapsedLabel('0:00');
      void pollTranscription(visitId);
      pollRef.current = window.setInterval(() => {
        void pollTranscription(visitId);
      }, 2_500);
    } catch (err) {
      setStage('error');
      setNotice({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Upload failed — note NOT created.',
      });
    }
  };

  const handleUpload = () => {
    if (!file || stage !== 'idle' || !consentChecked) return;
    consentAtRef.current = new Date().toISOString();
    setStage('uploading');
    void postTranscriptionJob();
  };

  /** ↻ Retry transcription — re-sends the SAME file (still held in memory)
   * against the SAME shell visit: no re-recording, no re-picking, no new
   * version-history row. Consent timestamp from the original attempt is
   * reused (it is the provenance of the consent event, not of the retry). */
  const retryTranscription = () => {
    if (!file || stage === 'uploading' || stage === 'transcribing') return;
    setStage('uploading');
    void postTranscriptionJob();
  };

  const mmss = (total: number) => {
    const m = Math.floor(total / 60);
    const s = Math.floor(total % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  if (!open) return null;

  const statusLine =
    stage === 'uploading'
      ? 'UPLOADING — sending your audio to the transcription worker…'
      : stage === 'transcribing'
      ? `TRANSCRIBING — AI worker running (${elapsedLabel}); keep this open or check the workspace list — NOTHING is sent to the record until it finishes.`
      : stage === 'done'
      ? 'AVAILABLE FOR REVIEW — draft ready in your workspace.'
      : stage === 'failed'
      ? 'AI TRANSCRIPTION FAILED — the audio is still here; nothing was invented.'
      : stage === 'error'
      ? 'FAILED — nothing was invented; fix the file and try again.'
      : file
      ? 'File ready. Confirm consent, then upload to generate the draft.'
      : 'Choose or drop an existing consultation audio file.';

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center ${t.overlay} backdrop-blur-sm`}
      role="dialog"
      aria-modal="true"
    >
      <div className={`w-full max-w-lg mx-4 rounded-2xl border shadow-2xl overflow-hidden ${t.panel}`}>
        {/* Header */}
        <div className={`flex items-center justify-between px-5 py-3 border-b ${t.headerBorder}`}>
          <div className="flex items-center gap-2">
            <span className={`w-8 h-8 rounded-full flex items-center justify-center text-sm ${t.brand}`}>
              📎
            </span>
            <span className={`font-bold ${t.title}`}>Upload Audio File</span>
            <span className={`text-[11px] px-2 py-0.5 rounded-full font-mono ${t.chip}`}>
              {contextLabel}
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              resetFile();
              setConsentChecked(false);
              onClose();
            }}
            disabled={stage === 'uploading' || stage === 'transcribing'}
            className={`text-sm disabled:opacity-40 ${t.close}`}
            title="Close (nothing is uploaded until you confirm)"
          >
            ✕
          </button>
        </div>

        <div className="px-5 py-6 space-y-5">
          {/* Drop zone / file picker */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              if (stage === 'idle') setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleDrop}
            className={`rounded-xl border-2 border-dashed p-6 text-center transition ${
              dragActive
                ? 'border-primary bg-primary/10'
                : file
                ? 'border-emerald-500/50 bg-emerald-950/30'
                : t.consentIdle
            }`}
          >
            {file ? (
              <div className="space-y-1">
                <div className={`text-sm font-bold ${t.title}`}>🎧 {file.name}</div>
                <div className={`text-xs font-mono ${t.sizeNote}`}>
                  {(file.size / (1024 * 1024)).toFixed(2)} MB ·{' '}
                  {resolveAudioMime(file) ?? 'unknown format'}
                  {durationSeconds !== null ? ` · ${mmss(durationSeconds)}` : ' · duration —'}
                </div>
                {stage !== 'uploading' && stage !== 'transcribing' && (
                  <button
                    type="button"
                    onClick={resetFile}
                    className={`text-xs underline underline-offset-2 ${t.close}`}
                  >
                    Choose a different file
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className={`text-4xl ${dragActive ? 'animate-bounce' : ''}`}>📁</div>
                <p className={`mt-2 text-sm font-semibold ${t.title}`}>
                  Drop audio here, or
                </p>
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  disabled={stage !== 'idle'}
                  className={`mt-3 px-4 py-2 rounded-xl text-sm font-bold disabled:opacity-40 ${t.idleMic}`}
                >
                  Browse Files
                </button>
                <p className={`mt-2 text-[11px] ${t.sizeNote}`}>
                  WebM · WAV · MP3 · M4A · AAC · OGG · FLAC · AIFF — max 25 MB (NFR-3)
                </p>
              </>
            )}
            <input
              ref={inputRef}
              type="file"
              accept="audio/webm,audio/wav,audio/x-wav,audio/mp3,audio/mpeg,audio/mp4,audio/x-m4a,audio/ogg,audio/opus,audio/aac,audio/flac,audio/x-flac,audio/aiff,.webm,.wav,.mp3,.m4a,.mp4,.aac,.ogg,.oga,.opus,.flac,.aiff"
              onChange={handlePick}
              disabled={stage !== 'idle'}
              className="hidden"
            />
          </div>

          {/* Status line */}
          <div className={`text-xs font-semibold uppercase tracking-wider text-center ${t.status}`}>
            {statusLine}
            {stage === 'uploading' && <span className="animate-pulse"> ⏳</span>}
          </div>

          {/* Upload / retry actions */}
          <div className="flex flex-wrap items-center justify-center gap-2.5">
            {file && stage === 'idle' && (
              <button
                type="button"
                onClick={handleUpload}
                disabled={!consentChecked}
                className={`px-5 py-2 rounded-xl text-sm font-bold disabled:opacity-40 ${t.idleMic}`}
              >
                📤 Upload &amp; Generate Note
              </button>
            )}
            {stage === 'failed' && (
              <button
                type="button"
                onClick={retryTranscription}
                className="px-5 py-2 rounded-xl text-sm font-bold bg-emerald-600 hover:bg-emerald-700 text-white"
              >
                ↻ Retry transcription
              </button>
            )}
            {stage === 'failed' && (
              <button
                type="button"
                onClick={resetFile}
                className={`px-4 py-2 rounded-xl text-sm font-semibold ${t.secondaryBtn}`}
              >
                Choose a different file
              </button>
            )}
            {file && stage === 'error' && (
              <button
                type="button"
                onClick={() => setStage('idle')}
                className={`px-5 py-2 rounded-xl text-sm font-bold ${t.idleMic}`}
              >
                ↺ Try Again
              </button>
            )}
          </div>

          {/* Consent strip (mandatory — same as live recording) */}
          <label
            className={`flex items-start gap-3 p-3 rounded-xl border text-xs ${
              consentChecked
                ? 'border-emerald-500/40 bg-emerald-950/40'
                : t.consentIdle
            }`}
          >
            <input
              type="checkbox"
              checked={consentChecked}
              onChange={(e) => setConsentChecked(e.target.checked)}
              disabled={stage !== 'idle'}
              className="mt-0.5 h-4 w-4"
            />
            <span className={consentChecked ? 'text-emerald-100' : t.consentIdleText}>
              <strong>Consent confirmed:</strong> the client consented to recording this
              consultation for documentation purposes. The consent timestamp is stored with the
              uploaded file as provenance — identical to live recordings.
            </span>
          </label>

          {/* Notice / banner */}
          {notice && (
            <div
              className={`p-3 rounded-xl border text-xs ${
                notice.tone === 'error'
                  ? 'bg-rose-950/80 border-rose-500/50 text-rose-100'
                  : 'bg-amber-950/80 border-amber-500/50 text-amber-100'
              }`}
            >
              {notice.text}
            </div>
          )}

          {/* Honest failure breakdown + "↻ Retry transcription" affordance */}
          {stage === 'failed' && (
            <div className="p-3 rounded-xl border bg-amber-950/80 border-amber-500/50 text-amber-100 text-xs leading-relaxed">
              <strong>Why:</strong>{' '}
              {lastAiError ??
                'the AI service could not finish this audio within its retry budget.'}{' '}
              — every key and model candidate was already tried automatically. Press{' '}
              <span className="font-bold">↻ Retry transcription</span> to re-send this exact file
              without recording anything again — brief demand spikes on Google's side usually
              clear within minutes, and the retry lands on whichever model is serving.
            </div>
          )}

          {/* Retention note */}
          <p className={`text-[11px] leading-relaxed ${t.retention}`}>
            Uploaded audio is processed for transcription only and never stored
            (<span className="font-mono">Deleted_After_Transcription</span>). The generated note
            stays grounded verbatim in what was actually spoken — untraceable AI claims are dropped
            and audited (FR-27/28).
          </p>
        </div>
      </div>
    </div>
  );
};
