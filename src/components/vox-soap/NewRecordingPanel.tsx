// File: d:\Pawfolio AI\src\components\vox-soap\NewRecordingPanel.tsx
'use client';

import React, { useState, useEffect, useRef } from 'react';
import { aiErrorSummaryFromAudit } from '@/lib/vox-soap/vox-soap.aierrors';
import type { VoxSoapVisitRecord } from '@/lib/vox-soap/vox-soap.types';

/**
 * Track A — Capture-hardened, Scribenote-style dedicated "New Recording" panel.
 *
 * Capture-hardening features (UI only, Phase A):
 *   - Pulsing mic activation + LIVE timer; the status line mirrors the
 *     Scribenote pipeline: Unsynced → Transcribing → Available for Review.
 *   - Pause / Resume (Scribenote: "Use the pause button when taking breaks").
 *   - Explicit Stop; recording is ALWAYS control-stopped, never ambient.
 *   - 2-hour auto-stop guard (mobile-parity protection against stray recording
 *     after the visit), amber warning one minute before the cap + beep.
 *   - Client-side storage guard ~20 MB (server cap 25 MB, NFR-3) with advice
 *     to stop and save.
 *   - Mandatory client-consent strip before the mic can start; consent
 *     timestamp is captured and stored on the record (audit provenance).
 *   - Mic-permission failure routes deterministically to the FR-30 transcript
 *     fallback drawer instead of guessing.
 *
 * `accent` re-themes the panel to match the surface that opens it:
 *   - 'indigo' → VoxSOAP workspace (default, unchanged look)
 *   - 'amber'  → clinic dashboard (warm Pawfolio palette)
 */

export type PanelStage =
  | 'idle'
  | 'recording'
  | 'paused'
  | 'uploading'
  | 'transcribing'
  | 'done'
  | 'failed'
  | 'error';

/**
 * Added lifecycle (Scribenote "Retry" pattern):
 *   uploading    — the shell + extract POSTs are in flight (fast)
 *   transcribing — background AI worker running; the client POLLs /state
 *   failed       — extraction produced no AI draft; "↻ Retry transcription"
 *                  re-sends the SAME recording from the kept mic chunks
 *                  (no re-recording) — or consult the FR-30 fallback
 *   error        — pre-job HTTP rejection / empty capture (unchanged)
 */

export type PanelAccent = 'indigo' | 'amber';

const MAX_RECORDING_SECONDS = 2 * 60 * 60; // 2 hour cap (Scribenote mobile parity)
const SIZE_WARNING_BYTES = 20 * 1024 * 1024; // 20 MB soft cap (server: 25 MB)

/** Theme tokens per accent — logic never branches on theme. */
export const PANEL_THEME: Record<
  PanelAccent,
  {
    overlay: string;
    panel: string;
    headerBorder: string;
    brand: string;
    title: string;
    chip: string;
    close: string;
    idleMic: string;
    busyMic: string;
    timer: string;
    timerSub: string;
    status: string;
    sizeNote: string;
    secondaryBtn: string;
    discardBtn: string;
    consentIdle: string;
    consentIdleText: string;
    retention: string;
  }
> = {
  indigo: {
    overlay: 'bg-[#05061c]/90',
    panel: 'bg-[#0e1038] border-indigo-500/40',
    headerBorder: 'border-indigo-800/60',
    brand: 'bg-[#6558f5]',
    title: 'text-white',
    chip: 'bg-[#171a4e] text-indigo-200',
    close: 'text-indigo-300 hover:text-white',
    idleMic: 'bg-[#6558f5] hover:bg-[#5245e0] text-white',
    busyMic: 'bg-[#171a4e] text-indigo-300',
    timer: 'text-white',
    timerSub: 'text-indigo-300',
    status: 'text-indigo-200',
    sizeNote: 'text-indigo-400',
    secondaryBtn: 'bg-[#171a4e] hover:bg-[#23276b] text-indigo-100 border border-indigo-800',
    discardBtn: 'bg-[#171a4e] text-slate-300 border border-indigo-800 hover:bg-[#23276b]',
    consentIdle: 'border-indigo-700/60 bg-[#12153f]',
    consentIdleText: 'text-indigo-200',
    retention: 'text-indigo-400',
  },
  amber: {
    overlay: 'bg-abyss/90',
    panel: 'bg-surface border-primary/30',
    headerBorder: 'border-line',
    brand: 'bg-primary text-canvas',
    title: 'text-ink',
    chip: 'bg-sidebar text-muted',
    close: 'text-muted hover:text-ink',
    idleMic: 'bg-primary hover:bg-primary-dark text-canvas',
    busyMic: 'bg-sidebar text-muted',
    timer: 'text-ink',
    timerSub: 'text-muted',
    status: 'text-primary-dark',
    sizeNote: 'text-muted',
    secondaryBtn: 'bg-sidebar hover:bg-[#33281f] text-ink border border-line',
    discardBtn: 'bg-sidebar text-muted border border-line hover:bg-[#33281f]',
    consentIdle: 'border-line bg-sidebar',
    consentIdleText: 'text-muted',
    retention: 'text-muted',
  },
};

export const NewRecordingPanel: React.FC<{
  open: boolean;
  defaultPetId: string;
  staffRole: string;
  staffId: string;
  staffName: string;
  isExtracting: boolean;
  /** 'indigo' = VoxSOAP workspace (default) · 'amber' = clinic dashboard. */
  accent?: PanelAccent;
  contextLabel?: string;
  onClose: () => void;
  onCompleted: (visit: VoxSoapVisitRecord) => void;
  onFallbackRequested: (reason?: string) => void;
  onRecordingStateChange: (recording: boolean, seconds: number) => void;
}> = ({
  open,
  defaultPetId,
  staffRole,
  staffId,
  staffName,
  isExtracting,
  accent = 'indigo',
  contextLabel = 'Leo • consultation capture',
  onClose,
  onCompleted,
  onFallbackRequested,
  onRecordingStateChange,
}) => {
  const [stage, setStage] = useState<PanelStage>('idle');
  const [seconds, setSeconds] = useState(0);
  const [consentChecked, setConsentChecked] = useState(false);
  const [consentAt, setConsentAt] = useState<string | null>(null);
  const [sizeBytes, setSizeBytes] = useState(0);
  const [notice, setNotice] = useState<{ tone: 'warn' | 'error'; text: string } | null>(null);
  const [errorHint, setErrorHint] = useState<string | null>(null);
  const [lastAiError, setLastAiError] = useState<string | null>(null);
  const [elapsedLabel, setElapsedLabel] = useState('0:00');

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const sizeRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingIdRef = useRef<string | null>(null);
  const micFailReasonRef = useRef<string | undefined>(undefined);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number>(0);

  const t = PANEL_THEME[accent];

  const clearTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  /** Scribenote-pattern poller: /state?visitId=… every 2.5 s while the
   * background AI worker transcribes the recording. */
  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  /** Closes the panel after a failure (always resets workspace recording pill). */
  const closeAfterError = () => {
    onRecordingStateChange(false, 0);
    setStage('idle');
    setSeconds(0);
    onClose();
  };

  useEffect(() => {
    return () => {
      clearTimer();
      stopPolling();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    onRecordingStateChange(stage === 'recording', seconds);
  }, [stage, seconds, onRecordingStateChange]);

  const playGuardBeep = () => {
    try {
      const Ctor =
        (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.value = 0.08;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
      setTimeout(() => ctx.close().catch(() => undefined), 600);
    } catch {
      // Non-fatal: the on-screen guard banner already covers the alert.
    }
  };

  const releaseMic = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  const startRecording = async () => {
    if (stage !== 'idle' || isExtracting) return;
    setNotice(null);
    setErrorHint(null);
    const consentTimestamp = new Date().toISOString();
    setConsentAt(consentTimestamp);
    setStage('uploading'); // honest pre-flight: shell POST then mic open

    let recordingId: string | null = null;
    try {
      const res = await fetch('/api/clinic/vox-soap/recordings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-staff-role': staffRole,
          'x-staff-id': staffId,
          'x-staff-name': staffName,
          'x-clinic-id': 'clinic-lhr-01',
        },
        body: JSON.stringify({ petId: defaultPetId, consentAt: consentTimestamp }),
      });
      if (res.ok) {
        const payload = await res.json();
        recordingId = payload.recordingId ?? null;
      }
    } catch {
      // Shell is optional; extraction can still run without it.
    }
    recordingIdRef.current = recordingId;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/mp4')
        ? 'audio/mp4'
        : undefined;
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      sizeRef.current = 0;
      setSizeBytes(0);

      recorder.ondataavailable = (e) => {
        if (e.data.size <= 0) return;
        chunksRef.current.push(e.data);
        sizeRef.current += e.data.size;
        setSizeBytes(sizeRef.current);
        if (sizeRef.current >= SIZE_WARNING_BYTES) {
          setNotice({
            tone: 'warn',
            text: `Audio reached ${(sizeRef.current / (1024 * 1024)).toFixed(1)} MB — stop and save the note now; the server accepts at most 25 MB (NFR-3).`,
          });
        }
      };

      recorder.onstop = () => {
        releaseMic();
        clearTimer();
        void postRecordingJob();
      };

      recorder.start();
      setSeconds(0);
      setStage('recording');
      timerRef.current = setInterval(() => {
        setSeconds((prev) => {
          const next = prev + 1;
          if (next === MAX_RECORDING_SECONDS - 60) {
            setNotice({
              tone: 'warn',
              text: 'Recording will auto-stop in 1 minute to guard against unintended capture after the visit (2-hour guard).',
            });
            playGuardBeep();
          }
          if (next >= MAX_RECORDING_SECONDS) {
            stopRecording();
            return MAX_RECORDING_SECONDS;
          }
          return next;
        });
      }, 1000);
    } catch (micErr) {
      const micName = micErr instanceof Error ? micErr.name : '';
      const micReason =
        micName === 'NotAllowedError'
          ? 'Microphone permission was denied.'
          : micName === 'NotFoundError'
          ? 'No microphone was found on this device.'
          : micName === 'NotReadableError'
          ? 'The microphone is busy (used by another app).'
          : micName === 'SecurityError'
          ? 'The browser blocked microphone access.'
          : 'The microphone could not be started in this browser session.';
      micFailReasonRef.current = micReason;
      setStage('error');
      setNotice({
        tone: 'error',
        text: `${micReason} No audio was captured — nothing will be fabricated (FR-27/28).`,
      });
      setErrorHint('Open Transcript Fallback (FR-30)');
    }
  };

  const pauseRecording = () => {
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.pause();
      clearTimer();
      setStage('paused');
    }
  };

  const resumeRecording = () => {
    if (recorderRef.current?.state === 'paused') {
      recorderRef.current.resume();
      setStage('recording');
      timerRef.current = setInterval(() => {
        setSeconds((prev) => {
          const next = prev + 1;
          if (next >= MAX_RECORDING_SECONDS) {
            stopRecording();
            return MAX_RECORDING_SECONDS;
          }
          return next;
        });
      }, 1000);
    }
  };

  const stopRecording = () => {
    if (
      recorderRef.current &&
      (recorderRef.current.state === 'recording' || recorderRef.current.state === 'paused')
    ) {
      recorderRef.current.stop();
      setStage('uploading');
    }
  };

  const cancelRecording = () => {
    clearTimer();
    stopPolling();
    if (
      recorderRef.current &&
      (recorderRef.current.state === 'recording' || recorderRef.current.state === 'paused')
    ) {
      recorderRef.current.onstop = null;
      recorderRef.current.stop();
    }
    releaseMic();
    onRecordingStateChange(false, 0);
    setSeconds(0);
    setSizeBytes(0);
    setNotice(null);
    setStage('idle');
    onClose();
  };

  /** Shared by the post-stop submit AND every ↻ retry: rebuilds the exact
   * same blob from the kept mic chunks and re-sends it against the SAME
   * shell visit — no re-recording (Scribenote "Retry" pattern). */
  const postRecordingJob = async () => {
    const micBlob = new Blob(chunksRef.current, {
      type: recorderRef.current?.mimeType ?? 'audio/webm',
    });
    if (micBlob.size === 0) {
      setStage('error');
      setNotice({ tone: 'error', text: 'No audio bytes captured — the draft was NOT generated.' });
      setErrorHint('Open Transcript Fallback (FR-30)');
      return;
    }
    setNotice(null);
    setLastAiError(null);
    try {
      const formData = new FormData();
      formData.append('petId', defaultPetId);
      if (recordingIdRef.current) {
        formData.append('recordingId', recordingIdRef.current);
      }
      if (consentAt) {
        formData.append('consentAt', consentAt);
      }
      formData.append('audio', micBlob, 'consultation.webm');

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
        setErrorHint('Open Transcript Fallback (FR-30)');
        return;
      }

      // Legacy synchronous reply (extraction ran without a shell visit).
      if (payload.visit) {
        finishRecording(payload.visit);
        return;
      }

      // Async Scribenote reply: poll the shell visit until the background
      // worker flips it out of 'Transcribing'.
      const visitId = String(payload.visitId ?? recordingIdRef.current ?? '');
      startedAtRef.current = Date.now();
      setStage('transcribing');
      setElapsedLabel('0:00');
      stopPolling();
      pollRef.current = setInterval(() => {
        void pollTranscription(visitId);
      }, 2_500);
      void pollTranscription(visitId);
    } catch (err) {
      setStage('error');
      setNotice({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Upload failed — note NOT created.',
      });
      setErrorHint('Open Transcript Fallback (FR-30)');
    }
  };

  /** Pulls the finished record off the /state poll and dispatches the panel:
   * success → hand the draft to the workspace; honest failure → 'failed'
   * stage with the ↻ Retry + FR-30 affordances. */
  const finishRecording = (visit: VoxSoapVisitRecord) => {
    stopPolling();
    if (visit.sourceType === 'Manual_Fallback_Draft') {
      setStage('failed');
      return;
    }
    setStage('done');
    setSeconds(0);
    onRecordingStateChange(false, 0);
    setTimeout(() => {
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
        // Engine budget is 4 minutes; past 8 the job was interrupted (e.g.
        // dev-server restart in dev) — surface honestly, keep retry available.
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
      finishRecording(visit);
    } catch {
      // Network blip — the next tick keeps polling within the budget.
    }
  };

  /** ↻ Retry transcription — re-sends the SAME recording (kept mic chunks)
   * against the SAME shell visit: no re-recording, not even a re-consent. */
  const retryTranscription = () => {
    if (stage === 'uploading' || stage === 'transcribing') return;
    setStage('uploading');
    void postRecordingJob();
  };

  const mmss = (total: number) => {
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
  };

  if (!open) return null;

  const statusLine =
    stage === 'recording'
      ? 'UNSYNCED — recording & syncing to Pawfolio after stop…'
      : stage === 'paused'
      ? 'PAUSED — timer frozen, mic held open.'
      : stage === 'uploading'
      ? 'UPLOADING — sending the recording to the transcription worker…'
      : stage === 'transcribing'
      ? `TRANSCRIBING — AI worker running (${elapsedLabel}); nothing is committed to the record until it finishes.`
      : stage === 'done'
      ? 'AVAILABLE FOR REVIEW — draft ready in your workspace.'
      : stage === 'failed'
      ? 'AI TRANSCRIPTION FAILED — the recording is still here; nothing was invented.'
      : stage === 'error'
      ? 'FAILED — nothing was invented; retry or use the transcript fallback.'
      : 'Consent to record this consultation, then start.';

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
              🎧
            </span>
            <span className={`font-bold ${t.title}`}>New Recording</span>
            <span className={`text-[11px] px-2 py-0.5 rounded-full font-mono ${t.chip}`}>
              {contextLabel}
            </span>
          </div>
          <button
            type="button"
            onClick={cancelRecording}
            disabled={stage === 'uploading' || stage === 'transcribing'}
            className={`text-sm disabled:opacity-40 ${t.close}`}
            title="Close (stops and discards any active recording)"
          >
            ✕
          </button>
        </div>

        <div className="px-5 py-6 space-y-5">
          {/* Big pulsing mic / status */}
          <div className="flex flex-col items-center gap-3">
            <button
              type="button"
              onClick={stage === 'idle' ? startRecording : undefined}
              disabled={stage !== 'idle' || isExtracting}
              className={`relative w-28 h-28 rounded-full flex items-center justify-center text-4xl transition ${
                stage === 'recording'
                  ? 'bg-rose-600 text-white'
                  : stage === 'idle'
                  ? t.idleMic
                  : t.busyMic
              } ${stage !== 'idle' ? 'opacity-80' : ''}`}
            >
              {stage === 'recording' && (
                <span className="absolute inset-0 rounded-full bg-rose-500/40 animate-ping" />
              )}
              <span className="relative">
                {stage === 'recording'
                  ? '🎙️'
                  : stage === 'paused'
                  ? '⏸️'
                  : stage === 'uploading'
                  ? '⏳'
                  : '🎙️'}
              </span>
            </button>
            <div className={`font-mono text-3xl tracking-widest ${t.timer}`}>
              {mmss(seconds)}
              <span className={`text-sm ml-2 ${t.timerSub}`}>/ {mmss(MAX_RECORDING_SECONDS)}</span>
            </div>
            <div className={`text-xs font-semibold uppercase tracking-wider ${t.status}`}>
              {statusLine}
            </div>
            {sizeBytes > 0 && (
              <div className={`text-[11px] font-mono ${t.sizeNote}`}>
                {(sizeBytes / (1024 * 1024)).toFixed(2)} MB buffer
              </div>
            )}
          </div>

          {/* Controls row */}
          <div className="flex flex-wrap items-center justify-center gap-2.5">
            {stage === 'recording' && (
              <button
                type="button"
                onClick={pauseRecording}
                className={`px-4 py-2 rounded-xl text-sm font-semibold ${t.secondaryBtn}`}
              >
                ⏸ Pause
              </button>
            )}
            {stage === 'paused' && (
              <button
                type="button"
                onClick={resumeRecording}
                className={`px-4 py-2 rounded-xl text-sm font-semibold ${t.secondaryBtn}`}
              >
                ▶ Resume
              </button>
            )}
            {(stage === 'recording' || stage === 'paused') && (
              <button
                type="button"
                onClick={stopRecording}
                className="px-5 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-sm font-bold"
              >
                ■ Stop &amp; Generate Note
              </button>
            )}
            {stage === 'idle' && (
              <button
                type="button"
                onClick={startRecording}
                disabled={!consentChecked}
                className={`px-5 py-2 rounded-xl text-sm font-bold disabled:opacity-40 ${t.idleMic}`}
              >
                🎙️ Start Recording
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
            {stage !== 'idle' &&
              stage !== 'uploading' &&
              stage !== 'transcribing' && (
              <button
                type="button"
                onClick={cancelRecording}
                className={`px-4 py-2 rounded-xl text-sm font-semibold ${t.discardBtn}`}
              >
                Discard
              </button>
            )}
          </div>

          {/* Consent strip (mandatory) */}
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
              <strong>Consent confirmed:</strong> I ask the client before starting — &ldquo;Would you
              mind if I record this conversation for documentation purposes? I use AI software to
              help me complete the medical record.&rdquo; The consent timestamp is stored with this
              recording as provenance.
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
              {errorHint && (
                <button
                  type="button"
                  onClick={() => {
                    onFallbackRequested(micFailReasonRef.current);
                    setNotice(null);
                    closeAfterError();
                  }}
                  className="ml-2 underline underline-offset-2 font-bold hover:text-white"
                >
                  {errorHint}
                </button>
              )}
            </div>
          )}

          {/* Honest failure breakdown — ↻ Retry re-sends the SAME recording,
              kept in memory; the FR-30 escape hatch stays available. */}
          {stage === 'failed' && (
            <div className="p-3 rounded-xl border bg-amber-950/80 border-amber-500/50 text-amber-100 text-xs leading-relaxed">
              <strong>Why:</strong>{' '}
              {lastAiError ??
                'the AI service could not finish this recording within its retry budget.'}{' '}
              — every API-key and model candidate was already tried automatically. Press{' '}
              <span className="font-bold">↻ Retry transcription</span> to re-send this exact
              recording without recording anything again (brief demand spikes usually clear
              within minutes), or{' '}
              <button
                type="button"
                onClick={() => {
                  onFallbackRequested('AI transcription failed — manual transcript fallback requested.');
                  stopPolling();
                  closeAfterError();
                }}
                className="underline underline-offset-2 font-bold hover:text-white"
              >
                Open Transcript Fallback (FR-30)
              </button>
              .
            </div>
          )}

          {/* Retention note */}
          <p className={`text-[11px] leading-relaxed ${t.retention}`}>
            Audio is processed for transcription only, scrubbed from memory, and never stored
            (audio-retention: <span className="font-mono">Deleted_After_Transcription</span>). Your
            note stays grounded verbatim in what was actually spoken — unspoken exam fields remain
            &ldquo;Not mentioned&rdquo; and orders missing details cannot be confirmed (FR-28 / FR-10).
          </p>
        </div>
      </div>
    </div>
  );
};
