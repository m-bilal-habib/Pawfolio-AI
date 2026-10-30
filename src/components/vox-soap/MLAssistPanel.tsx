// File: d:\Pawfolio AI\src\components\vox-soap\MLAssistPanel.tsx
'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  mlDraft,
  mlHealth,
  mlTranscribe,
  mlUnload,
  latencyLabel,
  type VoxSoapMLStaffHeaders,
} from '@/lib/vox-soap/voxsoap-ml.client';
import { pcm16kBytesForSeconds, startPcm16Capture, type Pcm16CaptureHandle } from '@/lib/vox-soap/voxsoap-ml.wav';
import type { VoxSoapMLCall, VoxSoapMLEnvelope } from '@/lib/vox-soap/voxsoap-ml.types';
import { PANEL_THEME, type PanelAccent } from './NewRecordingPanel';

/**
 * Phase 5 — "ML Assistive Draft" panel: mic → 16 kHz PCM WAV → LOCAL VoxSOAP
 * service (proxy /api/voxsoap/*) → editable transcript → editable SOAP draft
 * with deterministic guard badges.
 *
 * Honesty contract implemented here (feature contract §9, phase-4/5 reports):
 *   - every model output shows the envelope badges provider / serving_mode /
 *     model_scale / latency_s;
 *   - the draft is labeled ASSISTIVE — vet confirmation is mandatory; guard
 *     badges are deterministic ANNOTATIONS, never verdicts (review_hint shown
 *     verbatim);
 *   - a controlled error envelope (400/422/501/503) is rendered VERBATIM —
 *     no Gemini substitution, no invented success state;
 *   - the browser delivers exactly 16 kHz mono PCM WAV (client-side capture
 *     + resample); the server never resamples;
 *   - /roman stays a disabled control with its DEPRECATED-501 truth.
 */

type PanelStage =
  | 'checking'
  | 'forbidden'
  | 'unavailable'
  | 'ready'
  | 'recording'
  | 'paused'
  | 'encoding'
  | 'transcribing'
  | 'reviewTranscript'
  | 'drafting'
  | 'reviewDraft'
  | 'error';

const MAX_RECORDING_SECONDS = 12 * 60; // 720 s ≈ 23 MB — under the server's 25 MB audio cap
const WARN_MB = 20;
const TRANSCRIPT_MAX_CHARS = 14_000; // ml-serving config VOXSOAP_TRANSCRIPT_MAX_CHARS
const RATE_BYTES_PER_SECOND = 16_000 * 2; // s16le mono

interface Notice {
  tone: 'warn' | 'error' | 'info';
  text: string;
}

function scaleChips(scale: Record<string, string>): Array<{ key: string; value: string }> {
  return ['asr', 'soap', 'roman'].map((key) => ({ key, value: scale[key] ?? 'UNKNOWN' }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function scaleValueToString(scale: VoxSoapMLEnvelope['model_scale']): string | null {
  if (!scale) return null;
  if (typeof scale === 'string') return scale;
  if (isRecord(scale)) {
    const entries = Object.entries(scale);
    return entries.map(([k, v]) => `${k}: ${String(v)}`).join(' · ') || null;
  }
  return null;
}

/** Envelope badges — shown wherever model output appears. */
const EnvelopeBadges: React.FC<{ envelope: VoxSoapMLEnvelope }> = ({ envelope }) => {
  const scale = scaleValueToString(envelope.model_scale);
  return (
    <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
      {envelope.provider && (
        <span className="px-2 py-0.5 rounded bg-sidebar text-muted">provider: {envelope.provider}</span>
      )}
      {envelope.serving_mode && (
        <span className="px-2 py-0.5 rounded bg-sidebar text-muted">serving_mode: {envelope.serving_mode}</span>
      )}
      {scale && (
        <span className="px-2 py-0.5 rounded bg-primary/10 text-primary-dark">model_scale: {scale}</span>
      )}
      <span className="px-2 py-0.5 rounded bg-sidebar text-muted">latency_s: {latencyLabel(envelope.latency_s)}</span>
    </div>
  );
};

/** Controlled-error rendering — the envelope's own words, nothing rewritten. */
const ControlledErrorBox: React.FC<{ call: VoxSoapMLCall | null; heading?: string }> = ({
  call,
  heading = 'The ML request failed — shown exactly as the service reported it.',
}) => {
  if (!call) return null;
  const env = call.envelope;
  const detail =
    typeof env.detail === 'string' && env.detail.trim() ? env.detail.trim() : null;
  return (
    <div className="p-3 rounded-xl border border-rose-500/50 bg-rose-950/80 text-rose-100 text-xs space-y-1">
      <div className="font-bold">{heading}</div>
      <div className="font-mono text-[11px] text-rose-200">
        HTTP {call.status} · {String(env.error ?? 'error')}
      </div>
      <div>{env.message ?? 'No message from the service.'}</div>
      {detail && <div className="font-mono text-[11px] opacity-90 break-words">{detail}</div>}
      {env.note && <div className="italic opacity-80">{env.note}</div>}
      <div className="opacity-80">
        No Gemini substitute was used — ML failures stay ML failures until the local service answers.
      </div>
    </div>
  );
};

/** Guard annotation badges (meta + fact chips) — never a verdict. */
const GuardBadges: React.FC<{ envelope: VoxSoapMLEnvelope }> = ({ envelope }) => {
  const guard = envelope.guard;
  const remarks = envelope.note;
  if (!isRecord(guard)) return null;
  const schema = isRecord(guard.schema) ? guard.schema : null;
  const sections =
    schema && isRecord(schema.sections_present)
      ? (schema.sections_present as Record<string, boolean>)
      : null;
  const facts = isRecord(guard.facts)
    ? (guard.facts as {
        unsupported_numbers_in_draft: string[];
        unsupported_med_tokens_in_draft: string[];
        numbers_from_source_missing_in_draft: string[];
        med_tokens_from_source_missing_in_draft: string[];
      })
    : null;
  const unstated = Array.isArray(guard.unstated_markers_used_in_draft)
    ? (guard.unstated_markers_used_in_draft as string[])
    : [];
  const complete = Boolean(schema?.complete_schema);

  const FactGroup: React.FC<{ label: string; tokens: string[]; tone: 'bad' | 'warn' }> = ({
    label,
    tokens,
    tone,
  }) => (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] font-semibold text-muted">{label}:</span>
      {tokens.length === 0 ? (
        <span className="text-[11px] font-mono text-emerald-300">none flagged</span>
      ) : (
        tokens.map((token, i) => (
          <span
            key={`${label}-${i}`}
            className={`px-2 py-0.5 rounded font-mono text-[11px] ${
              tone === 'bad' ? 'bg-rose-950/60 text-rose-200' : 'bg-amber-950/60 text-amber-200'
            }`}
          >
            {token}
          </span>
        ))
      )}
    </div>
  );

  return (
    <div className="p-3 rounded-xl border border-line bg-sidebar space-y-2">
      <div className="font-mono text-[11px] font-bold text-ink">deterministic guard annotations</div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={`px-2 py-0.5 rounded text-[11px] font-mono font-bold ${
            complete ? 'bg-emerald-950/60 text-emerald-200' : 'bg-amber-950/60 text-amber-200'
          }`}
        >
          complete_schema: {complete ? 'true' : 'false'}
        </span>
        {sections &&
          Object.entries(sections).map(([section, present]) => (
            <span
              key={section}
              className={`px-2 py-0.5 rounded text-[11px] font-mono ${
                present ? 'bg-sidebar text-emerald-300' : 'bg-sidebar text-rose-300'
              }`}
            >
              {section}: {present ? '✓' : '✗'}
            </span>
          ))}
      </div>
      {facts && (
        <>
          <FactGroup label="numbers in draft NOT in transcript" tokens={facts.unsupported_numbers_in_draft ?? []} tone="bad" />
          <FactGroup label="med tokens in draft NOT in transcript" tokens={facts.unsupported_med_tokens_in_draft ?? []} tone="bad" />
          <FactGroup label="numbers from transcript missing in draft" tokens={facts.numbers_from_source_missing_in_draft ?? []} tone="warn" />
          <FactGroup label="med tokens from transcript missing in draft" tokens={facts.med_tokens_from_source_missing_in_draft ?? []} tone="warn" />
        </>
      )}
      {unstated.length > 0 && (
        <FactGroup label="unstated markers used" tokens={unstated} tone="warn" />
      )}
      <div className="text-[11px] italic text-muted">
        {typeof guard.review_hint === 'string' ? guard.review_hint : 'deterministic annotations only.'}
      </div>
      {typeof remarks === 'string' && remarks && (
        <div className="text-[11px] text-muted">service note: {remarks}</div>
      )}
    </div>
  );
};

export const MLAssistPanel: React.FC<{
  open: boolean;
  staffRole: string;
  staffId: string;
  staffName: string;
  accent?: PanelAccent;
  contextLabel?: string;
  onClose: () => void;
}> = ({
  open,
  staffRole,
  staffId,
  staffName,
  accent = 'amber',
  contextLabel = 'ML assist • local service',
  onClose,
}) => {
  const [stage, setStage] = useState<PanelStage>('checking');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [sizeBytes, setSizeBytes] = useState(0);
  const [consentChecked, setConsentChecked] = useState(false);
  const [health, setHealth] = useState<VoxSoapMLCall | null>(null);
  const [transcribeCall, setTranscribeCall] = useState<VoxSoapMLCall | null>(null);
  const [draftCall, setDraftCall] = useState<VoxSoapMLCall | null>(null);
  const [unloadCall, setUnloadCall] = useState<VoxSoapMLCall | null>(null);
  const [transcript, setTranscript] = useState('');
  const [draft, setDraft] = useState('');
  const [elapsedLabel, setElapsedLabel] = useState('0:00');
  const [working, setWorking] = useState(false);

  const staff: VoxSoapMLStaffHeaders = { role: staffRole, id: staffId, name: staffName };
  const t = PANEL_THEME[accent];

  const streamRef = useRef<MediaStream | null>(null);
  const captureRef = useRef<Pcm16CaptureHandle | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const encodingRef = useRef(false);

  const clearTimers = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (elapsedRef.current) {
      clearInterval(elapsedRef.current);
      elapsedRef.current = null;
    }
  }, []);

  const releaseMic = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    captureRef.current?.cancel();
    captureRef.current = null;
  }, []);

  const startElapsedTicker = useCallback(() => {
    const startedAt = Date.now();
    elapsedRef.current = setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      setElapsedLabel(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
    }, 1000);
    setElapsedLabel('0:00');
  }, []);

  const resetFlow = useCallback(() => {
    clearTimers();
    releaseMic();
    encodingRef.current = false;
    setSeconds(0);
    setSizeBytes(0);
    setTranscript('');
    setDraft('');
    setTranscribeCall(null);
    setDraftCall(null);
    setUnloadCall(null);
    setNotice(null);
    setStage('ready');
  }, [clearTimers, releaseMic]);

  const checkHealth = useCallback(async () => {
    setStage('checking');
    setNotice(null);
    const result = await mlHealth(staff);
    setHealth(result);
    const env = result.envelope;
    const scaleMap = isRecord(env.model_scale) && typeof env.model_scale === 'object' && !Array.isArray(env.model_scale)
      ? (env.model_scale as Record<string, string>)
      : null;
    if (result.status === 200 && env.ok && scaleMap) {
      setStage('ready');
    } else {
      setStage('unavailable');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staff.id, staff.name, staff.role]);

  useEffect(() => {
    if (!open) return;
    if (staffRole === 'receptionist') {
      setStage('forbidden');
      return;
    }
    void checkHealth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, staffRole]);

  useEffect(() => {
    if (open) return;
    // Panel closed upstream: release everything, reset next open.
    clearTimers();
    releaseMic();
  }, [open, clearTimers, releaseMic]);

  useEffect(() => () => clearTimers(), [clearTimers]);

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

  const startRecording = async () => {
    if (stage !== 'ready') return;
    setNotice(null);
    setStage('recording');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      const capture = await startPcm16Capture(stream);
      captureRef.current = capture;
      setSizeBytes(0);
      setSeconds(0);
      timerRef.current = setInterval(() => {
        setSeconds((prev) => {
          const next = prev + 1;
          const bytes = pcm16kBytesForSeconds(next);
          if (bytes % (RATE_BYTES_PER_SECOND * 5) < RATE_BYTES_PER_SECOND) {
            setSizeBytes(bytes);
          }
          if (next === MAX_RECORDING_SECONDS - 60) {
            setNotice({
              tone: 'warn',
              text: 'Recording will auto-stop in 1 minute — the local service accepts at most 25 MB of audio (~13 min) and never resamples.',
            });
            playGuardBeep();
          }
          if (next >= MAX_RECORDING_SECONDS) {
            void finishRecording();
            return MAX_RECORDING_SECONDS;
          }
          return next;
        });
      }, 1000);
    } catch (err) {
      releaseMic();
      setStage('ready');
      const name = err instanceof Error ? err.name : '';
      const reason =
        name === 'NotAllowedError'
          ? 'Microphone permission was denied.'
          : name === 'NotFoundError'
          ? 'No microphone was found on this device.'
          : name === 'NotReadableError'
          ? 'The microphone is busy (used by another app).'
          : err instanceof Error
          ? err.message
          : 'The microphone could not be started.';
      setNotice({ tone: 'error', text: `${reason} No audio was captured — nothing will be invented.` });
    }
  };

  const pauseRecording = () => {
    if (stage !== 'recording') return;
    captureRef.current?.setPaused(true);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setStage('paused');
  };

  const resumeRecording = () => {
    if (stage !== 'paused') return;
    captureRef.current?.setPaused(false);
    timerRef.current = setInterval(() => {
      setSeconds((prev) => {
        const next = prev + 1;
        if (next >= MAX_RECORDING_SECONDS) {
          void finishRecording();
          return MAX_RECORDING_SECONDS;
        }
        return next;
      });
    }, 1000);
    setStage('recording');
  };

  const finishRecording = async () => {
    // StrictMode double-invokes state updaters in dev — the auto-stop path
    // would otherwise risk two concurrent encode+upload passes of the SAME
    // recording. Idempotent by ref, not by closure state.
    if (encodingRef.current) return;
    encodingRef.current = true;
    setStage('encoding');
    clearTimers();
    const capture = captureRef.current;
    const stream = streamRef.current;
    try {
      if (!capture || !stream) throw new Error('No active capture to stop.');
      stream.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      captureRef.current = null;
      const wav = await capture.stop();
      capture.cancel();
      if (wav.size === 0) {
        throw new Error('No audio bytes were captured — the transcript was NOT generated.');
      }
      if (wav.size > 25 * 1024 * 1024) {
        throw new Error(
          `${(wav.size / (1024 * 1024)).toFixed(1)} MB exceeds the local service's 25 MB audio cap — nothing was uploaded. Record a shorter window.`
        );
      }
      setSizeBytes(wav.size);
      await postTranscribe(wav);
    } catch (err) {
      encodingRef.current = false;
      releaseMic();
      setStage('error');
      setNotice({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Recording could not be encoded — nothing was uploaded.',
      });
    }
  };

  const postTranscribe = async (wav: Blob) => {
    setStage('transcribing');
    startElapsedTicker();
    const result = await mlTranscribe(wav, staff);
    clearTimers();
    setTranscribeCall(result);
    const env = result.envelope;
    if (result.status === 200 && env.ok && typeof env.text === 'string') {
      encodingRef.current = false;
      setTranscript(env.text);
      setNotice(
        typeof env.note === 'string' && env.note
          ? { tone: 'info', text: env.note }
          : null
      );
      setStage('reviewTranscript');
      return;
    }
    setStage('error');
  };

  const postDraft = async () => {
    const trimmed = transcript.trim();
    if (!trimmed) {
      setNotice({ tone: 'warn', text: 'The transcript is empty — provide the conversation text first (nothing invented).' });
      return;
    }
    if (trimmed.length > TRANSCRIPT_MAX_CHARS) {
      setNotice({
        tone: 'warn',
        text: `Transcript is ${trimmed.length} chars — the server cap is ${TRANSCRIPT_MAX_CHARS} (VOXSOAP_TRANSCRIPT_MAX_CHARS). Shorten it first.`,
      });
      return;
    }
    setNotice(null);
    setDraftCall(null);
    setStage('drafting');
    startElapsedTicker();
    const result = await mlDraft(trimmed, staff);
    clearTimers();
    setDraftCall(result);
    const env = result.envelope;
    if (result.status === 200 && env.ok && typeof env.draft === 'string') {
      setDraft(env.draft);
      setStage('reviewDraft');
      return;
    }
    setStage('error');
  };

  const postUnload = async () => {
    if (working) return;
    setWorking(true);
    const result = await mlUnload('all', staff);
    setWorking(false);
    setUnloadCall(result);
    const env = result.envelope;
    if (result.status === 200 && env.ok) {
      setNotice({
        tone: 'info',
        text:
          'Models unloaded — the reference was dropped and RAM should return to ~pre-load (see the status envelope below). Loading happens automatically on the next request.',
      });
    } else {
      setNotice({ tone: 'error', text: 'The unload request failed — see the status envelope below.' });
    }
  };

  const copyToClipboard = async (key: 'transcript' | 'draft', value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice({ tone: 'info', text: `The ${key} was copied to the clipboard (the ML service itself stores nothing).` });
    } catch {
      setNotice({ tone: 'warn', text: 'Clipboard write was blocked by the browser — select and copy manually.' });
    }
  };

  if (!open) return null;

  const statusLine =
    stage === 'checking'
      ? 'CHECKING — probing GET /api/voxsoap/health …'
      : stage === 'unavailable'
      ? 'UNAVAILABLE — the local VoxSOAP ML service is not answering.'
      : stage === 'recording'
      ? 'RECORDING — capturing 16 kHz mono PCM (nothing leaves this machine).'
      : stage === 'paused'
      ? 'PAUSED — timer frozen, mic held open.'
      : stage === 'encoding'
      ? 'ENCODING — building the 16 kHz PCM WAV client-side…'
      : stage === 'transcribing'
      ? `TRANSCRIBING — real Whisper runs locally on ${elapsedLabel}; loading loads on first request.`
      : stage === 'reviewTranscript'
      ? 'REVIEW — edit the transcript, then request the assistive draft.'
      : stage === 'drafting'
      ? `DRAFTING — the 3B SOAP model loads on demand (~12–13 GB fp32 on CPU; on GPU ~6 GB) — running ${elapsedLabel}…`
      : stage === 'reviewDraft'
      ? 'REVIEW DRAFT — assistive note with guard annotations; vet confirmation is MANDATORY.'
      : stage === 'error'
      ? 'FAILED — the controlled error is shown verbatim; nothing was substituted.'
      : stage === 'forbidden'
      ? 'FORBIDDEN — receptionists cannot initiate clinical SOAP dictation (FR-6).'
      : 'Service reachable — consent, then record.';

  const sizeMBText = (sizeBytes / (1024 * 1024)).toFixed(2);
  const healthScale =
    health && isRecord(health.envelope.model_scale) && !Array.isArray(health.envelope.model_scale)
      ? (health.envelope.model_scale as Record<string, string>)
      : null;
  const isMockProvider = Boolean(
    health && isRecord(health.envelope.providers) && isRecord((health.envelope.providers as Record<string, unknown>).ml)
      ? ((health.envelope.providers as Record<string, unknown>).ml as Record<string, unknown>).is_mock
      : false
  );

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center ${t.overlay} backdrop-blur-sm`}
      role="dialog"
      aria-modal="true"
    >
      <div className={`w-full max-w-3xl max-h-[92vh] overflow-y-auto mx-4 rounded-2xl border shadow-2xl ${t.panel}`}>
        <div className={`flex items-center justify-between px-5 py-3 border-b ${t.headerBorder} sticky top-0 z-10 ${t.panel}`}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`w-8 h-8 rounded-full flex items-center justify-center text-sm ${t.brand}`}>🧠</span>
            <span className={`font-bold ${t.title}`}>ML Assistive Draft</span>
            <span className={`text-[11px] px-2 py-0.5 rounded-full font-mono ${t.chip}`}>{contextLabel}</span>
            {stage === 'reviewDraft' || stage === 'drafting' ? (
              <span className="text-[10px] px-2 py-0.5 rounded-full font-mono bg-amber-500/20 text-amber-200 border border-amber-500/50">
                assistive — vet confirmation mandatory
              </span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`text-sm disabled:opacity-40 ${t.close}`}
            title="Close (any active recording is stopped and discarded)"
          >
            ✕
          </button>
        </div>

        <div className="px-5 py-5 space-y-4">
          {/* Health strip */}
          {(stage !== 'forbidden') && healthScale && (
            <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
              <span className="text-muted">local service:</span>
              {scaleChips(healthScale).map((chip) => (
                <span
                  key={chip.key}
                  className={`px-2 py-0.5 rounded ${
                    chip.value.startsWith('FULL')
                      ? 'bg-emerald-950/60 text-emerald-200'
                      : chip.value.includes('UNAVAILABLE') || chip.value.includes('UNKNOWN')
                      ? 'bg-amber-950/60 text-amber-200'
                      : 'bg-sidebar text-muted'
                  }`}
                >
                  {chip.key}: {chip.value}
                </span>
              ))}
              {isMockProvider && (
                <span className="px-2 py-0.5 rounded bg-rose-950/60 text-rose-200">
                  serving a MOCK provider — model_scale labels must be checked
                </span>
              )}
            </div>
          )}

          {/* Roman: honestly 501 */}
          {stage !== 'forbidden' && stage !== 'checking' && stage !== 'unavailable' && (
            <div className="flex items-center gap-2 text-[11px] text-muted">
              <button
                type="button"
                disabled
                className="px-2 py-1 rounded bg-sidebar text-muted border border-line cursor-not-allowed"
                title="Model C is DEPRECATED (runs 9/10/11 failed) — /roman answers an honest 501 until a passing adapter is configured."
              >
                /roman
              </button>
              <span>transliteration is disabled — Model C DEPRECATED (2026-10-29), route answers 501.</span>
            </div>
          )}

          {/* Unavailable (health failed) */}
          {stage === 'unavailable' && (
            <div className="space-y-3">
              <ControlledErrorBox call={health} heading="The local VoxSOAP ML service did not answer its health probe." />
              <p className="text-xs text-muted leading-relaxed">
                Start it once per login:
                <span className="block font-mono text-[11px] mt-1 bg-sidebar rounded p-2 text-ink">
                  &quot;D:\Pawfolio AI\.venv-ml64\Scripts\python&quot; -m uvicorn app:app --app-dir &quot;D:\Pawfolio AI\ml-serving&quot; --host 127.0.0.1 --port 8321
                </span>
                Setup: <span className="font-mono">ml-serving/reports/phase5_integration_plan.md</span> §1.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void checkHealth()}
                  className="px-4 py-2 rounded-xl bg-primary hover:bg-primary-dark text-canvas text-sm font-bold"
                >
                  ↻ Retry health probe
                </button>
                <button type="button" onClick={onClose} className={`px-4 py-2 rounded-xl text-sm font-semibold ${t.secondaryBtn}`}>
                  Close
                </button>
              </div>
            </div>
          )}

          {/* Forbidden */}
          {stage === 'forbidden' && (
            <p className="text-sm text-ink">
              FR-6: receptionists cannot initiate clinical SOAP dictation — the ML assistive flow is
              unavailable for this role. Every other existing role may use it; the proxy enforces the
              same rule server-side.
            </p>
          )}

          {/* Ready / recording / paused / encoding */}
          {(stage === 'ready' || stage === 'recording' || stage === 'paused' || stage === 'encoding') && (
            <div className="space-y-4">
              <div className="flex flex-col items-center gap-3">
                <div
                  className={`relative w-24 h-24 rounded-full flex items-center justify-center text-3xl ${
                    stage === 'recording' ? 'bg-rose-600 text-white' : t.busyMic
                  }`}
                >
                  {stage === 'recording' && <span className="absolute inset-0 rounded-full bg-rose-500/40 animate-ping" />}
                  <span className="relative">{stage === 'paused' ? '⏸️' : '🎙️'}</span>
                </div>
                <div className={`font-mono text-2xl tracking-widest ${t.timer}`}>
                  {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
                  <span className={`text-sm ml-2 ${t.timerSub}`}>/ {Math.floor(MAX_RECORDING_SECONDS / 60)}:00</span>
                </div>
                <div className={`text-xs font-semibold uppercase tracking-wider ${t.status}`}>{statusLine}</div>
                {(sizeBytes > 0 || stage !== 'ready') && (
                  <div
                    className={`text-[11px] font-mono ${
                      sizeBytes > WARN_MB * 1024 * 1024
                        ? 'text-rose-300 font-bold'
                        : t.sizeNote
                    }`}
                  >
                    {sizeMBText} MB WAV buffer (~25 MB server cap · 16 kHz mono PCM s16le
                    {sizeBytes > WARN_MB * 1024 * 1024 ? ' — stop soon' : ''})
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-center gap-2.5">
                {stage === 'ready' && (
                  <button
                    type="button"
                    onClick={() => void startRecording()}
                    disabled={!consentChecked}
                    className={`px-5 py-2 rounded-xl text-sm font-bold disabled:opacity-40 ${t.idleMic}`}
                  >
                    🎙️ Start Recording
                  </button>
                )}
                {stage === 'recording' && (
                  <button type="button" onClick={pauseRecording} className={`px-4 py-2 rounded-xl text-sm font-semibold ${t.secondaryBtn}`}>
                    ⏸ Pause
                  </button>
                )}
                {stage === 'paused' && (
                  <button type="button" onClick={resumeRecording} className={`px-4 py-2 rounded-xl text-sm font-semibold ${t.secondaryBtn}`}>
                    ▶ Resume
                  </button>
                )}
                {(stage === 'recording' || stage === 'paused') && (
                  <button
                    type="button"
                    onClick={() => void finishRecording()}
                    className="px-5 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-sm font-bold"
                  >
                    ■ Stop &amp; Transcribe
                  </button>
                )}
                {stage === 'encoding' && (
                  <span className="text-xs font-mono text-muted">encoding…</span>
                )}
                {(stage === 'recording' || stage === 'paused') && (
                  <button
                    type="button"
                    onClick={() => {
                      clearTimers();
                      releaseMic();
                      setSeconds(0);
                      setSizeBytes(0);
                      setStage('ready');
                    }}
                    className={`px-4 py-2 rounded-xl text-sm font-semibold ${t.discardBtn}`}
                  >
                    Discard
                  </button>
                )}
              </div>

              <label
                className={`flex items-start gap-3 p-3 rounded-xl border text-xs ${
                  consentChecked ? 'border-emerald-500/40 bg-emerald-950/40' : t.consentIdle
                }`}
              >
                <input
                  type="checkbox"
                  checked={consentChecked}
                  onChange={(e) => setConsentChecked(e.target.checked)}
                  disabled={stage !== 'ready'}
                  className="mt-0.5 h-4 w-4"
                />
                <span className={consentChecked ? 'text-emerald-100' : t.consentIdleText}>
                  <strong>Consent confirmed</strong> for recording, and I understand this flow runs the
                  LOCAL VoxSOAP models on this machine (Whisper transcription, then an assistive SOAP
                  draft). Nothing goes to any cloud model; the draft requires veterinary confirmation.
                </span>
              </label>
            </div>
          )}

          {/* Transcript review */}
          {(stage === 'reviewTranscript' || stage === 'drafting') && (
            <div className="space-y-3">
              {transcribeCall && transcribeCall.status === 200 && (
                <EnvelopeBadges envelope={transcribeCall.envelope} />
              )}
              <div className="flex items-center justify-between">
                <div className="text-xs font-bold text-ink">Transcript (editable)</div>
                <div className="text-[11px] font-mono text-muted">
                  {transcript.length} / {TRANSCRIPT_MAX_CHARS}
                  {transcript.length > TRANSCRIPT_MAX_CHARS * 0.95 && (
                    <span className="ml-2 text-amber-300">near server cap</span>
                  )}
                </div>
              </div>
              <textarea
                rows={7}
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
                disabled={stage === 'drafting'}
                className="w-full rounded-xl bg-canvas border border-line p-3 text-xs font-mono text-ink focus:outline-none"
              />
              {stage === 'reviewTranscript' && (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void postDraft()}
                    className="px-5 py-2 rounded-xl bg-primary hover:bg-primary-dark text-canvas text-sm font-bold"
                    title="Draft inference runs locally; on CPU it can take a couple of minutes (3B fp32)"
                  >
                    ✨ Generate assistive SOAP draft
                  </button>
                  <button type="button" onClick={() => void copyToClipboard('transcript', transcript)} className={`px-4 py-2 rounded-xl text-sm font-semibold ${t.secondaryBtn}`}>
                    Copy transcript
                  </button>
                  <button type="button" onClick={resetFlow} className={`px-4 py-2 rounded-xl text-sm font-semibold ${t.discardBtn}`}>
                    🎙️ Re-record
                  </button>
                </div>
              )}
              {stage === 'drafting' && (
                <p className="text-xs text-muted">
                  {statusLine} The envelope arrives when inference finishes; on timeout the honest
                  failure is shown — no partial note is manufactured.
                </p>
              )}
            </div>
          )}

          {/* Draft review */}
          {stage === 'reviewDraft' && draftCall && (
            <div className="space-y-3">
              {transcribeCall && transcribeCall.status === 200 && (
                <EnvelopeBadges envelope={transcribeCall.envelope} />
              )}
              <EnvelopeBadges envelope={draftCall.envelope} />
              <div className="text-xs font-bold text-ink">
                SOAP draft (editable){' '}
                <span className="font-normal text-muted">— assistive; veterinarian confirmation is mandatory</span>
              </div>
              <textarea
                rows={10}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="w-full rounded-xl bg-canvas border border-line p-3 text-xs font-mono text-ink focus:outline-none"
              />
              <GuardBadges envelope={draftCall.envelope} />
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => void copyToClipboard('draft', draft)} className={`px-4 py-2 rounded-xl text-sm font-semibold ${t.secondaryBtn}`}>
                  Copy draft
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDraftCall(null);
                    setDraft('');
                    setStage('reviewTranscript');
                  }}
                  className={`px-4 py-2 rounded-xl text-sm font-semibold ${t.discardBtn}`}
                >
                  Edit transcript instead
                </button>
              </div>
            </div>
          )}

          {/* Error */}
          {stage === 'error' && (
            <div className="space-y-3">
              <ControlledErrorBox
                call={draftCall && !draftCall.envelope.ok ? draftCall : transcribeCall}
                heading="The ML request failed — shown exactly as the service reported it."
              />
              <div className="flex flex-wrap gap-2">
                {transcript.trim() ? (
                  <button
                    type="button"
                    onClick={() => {
                      setDraftCall(null);
                      setStage('reviewTranscript');
                    }}
                    className={`px-4 py-2 rounded-xl text-sm font-semibold ${t.secondaryBtn}`}
                  >
                    Keep transcript, retry draft
                  </button>
                ) : null}
                <button type="button" onClick={resetFlow} className={`px-4 py-2 rounded-xl text-sm font-semibold ${t.secondaryBtn}`}>
                  Start over
                </button>
              </div>
            </div>
          )}

          {/* Notice */}
          {notice && (
            <div
              className={`p-3 rounded-xl border text-xs ${
                notice.tone === 'error'
                  ? 'bg-rose-950/80 border-rose-500/50 text-rose-100'
                  : notice.tone === 'warn'
                  ? 'bg-amber-950/80 border-amber-500/50 text-amber-100'
                  : 'bg-emerald-950/60 border-emerald-500/40 text-emerald-100'
              }`}
            >
              {notice.text}
            </div>
          )}

          {/* Unload status envelope (after use) */}
          {unloadCall && unloadCall.status === 200 && isRecord(unloadCall.envelope) && unloadCall.envelope.ok && (
            <div className="p-3 rounded-xl border border-line bg-sidebar text-[11px] font-mono text-muted space-y-1">
              <div>
                unload_status:{' '}
                {isRecord(unloadCall.envelope.unload_status)
                  ? Object.entries(unloadCall.envelope.unload_status as Record<string, unknown>)
                      .map(([k, v]) => `${k}: ${String(v)}`)
                      .join(' · ')
                  : 'n/a'}
              </div>
              {isRecord(unloadCall.envelope.model_scale_after) && (
                <div>
                  model_scale_after:{' '}
                  {Object.entries(unloadCall.envelope.model_scale_after as Record<string, string>)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(' · ')}
                </div>
              )}
              {typeof unloadCall.envelope.note === 'string' && <div className="italic">{unloadCall.envelope.note}</div>}
            </div>
          )}

          {/* Footer honesty + unload */}
          {stage !== 'forbidden' && stage !== 'checking' && (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-line">
              <p className="text-[11px] leading-relaxed text-muted max-w-md">
                Local-only ML scaffold: no cloud model is contacted from this panel, and a failing ML
                call is a controlled error — never a Gemini replacement. Drafts are assistive; the
                veterinary reviewer of record confirms the final note.
              </p>
              <button
                type="button"
                onClick={() => void postUnload()}
                disabled={working || stage === 'recording' || stage === 'paused' || stage === 'transcribing' || stage === 'drafting'}
                className={`px-3 py-1.5 rounded-xl text-[11px] font-semibold disabled:opacity-40 ${t.secondaryBtn}`}
                title="POST /unload — free the model RAM (the Windows RAM safeguard)"
              >
                ⏏ Unload models
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
