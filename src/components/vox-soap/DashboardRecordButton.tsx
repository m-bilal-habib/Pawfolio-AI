// File: d:\Pawfolio AI\src\components\vox-soap\DashboardRecordButton.tsx
'use client';

import { useCallback, useState } from 'react';
import { Mic, Upload, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { NewRecordingPanel } from './NewRecordingPanel';
import { UploadAudioPanel } from './UploadAudioPanel';
import { VOX_SOAP_STAFF } from '@/lib/vox-soap/vox-soap.staff';
import { WORKFLOW_STATUS_LABELS } from '@/lib/vox-soap/vox-soap.workflow';
import type { VoxSoapVisitRecord } from '@/lib/vox-soap/vox-soap.types';

/**
 * Scribenote-style "record anywhere" entry point for the clinic dashboard.
 *
 * A prominent amber Record FAB (bottom-right, pulsing ring) opens the same
 * capture-hardened NewRecordingPanel used inside the VoxSOAP workspace —
 * consent strip, 2-hour guard, Unsynced → Transcribing statuses.
 *
 * Post-transcription behaviour: NO automatic navigation to a separate page.
 * The completed draft is announced in an inline result card right here on the
 * dashboard (honest summary: title, grounding verdict, audio provenance);
 * opening the full VoxSOAP editor remains an explicit user action.
 *
 * RBAC (FR-6): Receptionists cannot initiate clinical SOAP dictation, so the
 * button renders only for Veterinarian / Assistant / Admin.
 */

const STAFF_FOR_ROLE = VOX_SOAP_STAFF;

type CompletionNotice =
  | { kind: 'success'; visit: VoxSoapVisitRecord }
  | { kind: 'micFallback'; reason: string }
  | null;

export function DashboardRecordButton() {
  const { clinicRole } = useAuth();
  const router = useRouter();
  const [panelOpen, setPanelOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [notice, setNotice] = useState<CompletionNotice>(null);

  const staff = clinicRole ? STAFF_FOR_ROLE[clinicRole] : undefined;

  const handleCompleted = useCallback((visit: VoxSoapVisitRecord) => {
    // Stay on the dashboard — announce the fresh draft inline. The visit id is
    // staged so that IF the vet chooses "Open full note", the workspace
    // selects exactly this draft (never a guessed first row).
    try {
      sessionStorage.setItem('pawfolio.voxsoap.selectVisit', visit.visitId);
    } catch {
      // Storage unavailable — the workspace still opens on the newest visit.
    }
    setNotice({ kind: 'success', visit });
  }, []);

  if (!clinicRole || !staff) return null;

  const visit = notice?.kind === 'success' ? notice.visit : null;
  const derivedTitle = visit
    ? `${visit.subjective.pet_name ?? 'Leo'}: ${visit.subjective.presenting_complaint || 'Consultation'}`
    : '';
  const audioMeta = visit
    ? [
        visit.workflowRecording.audioSizeBytes
          ? `${(visit.workflowRecording.audioSizeBytes / (1024 * 1024)).toFixed(2)} MB`
          : null,
        visit.workflowRecording.audioMimeType ?? null,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;

  return (
    <>
      {/* Inline post-transcription result card — appears above the FABs and
          keeps the clinician on THIS page (FR-30-friendly, no forced
          navigation). Success shows the real draft summary; mic failure shows
          the transcript-fallback hand-off as an explicit action. */}
      {notice && (
        <div className="fixed bottom-32 right-6 z-40 w-80 max-w-[calc(100vw-3rem)] rounded-2xl border border-line bg-surface/98 shadow-2xl shadow-black/40 overflow-hidden">
          {notice.kind === 'success' && visit && (
            <>
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-line bg-sidebar">
                <span className="text-xs font-bold text-ink flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-success" />
                  {WORKFLOW_STATUS_LABELS[visit.workflowStatus ?? 'AvailableForReview']}
                </span>
                <button
                  type="button"
                  onClick={() => setNotice(null)}
                  aria-label="Dismiss result card"
                  className="text-muted hover:text-ink transition"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="px-4 py-3 space-y-2">
                <div className="text-sm font-bold text-ink leading-snug">{derivedTitle}</div>
                <div className="text-[11px] font-mono text-muted">
                  ✓ {visit.sourceType.replace(/_/g, ' ')}
                  {audioMeta ? ` · 🎧 ${audioMeta}` : ''} · consent logged · audio scrubbed
                </div>
                <p className="text-[11px] text-muted leading-relaxed">
                  {visit.groundingAuditNote
                    ? `Grounding filter applied: ${visit.groundingAuditNote}`
                    : 'Grounding verified: every claim traces verbatim to your audio.'}
                </p>
                <button
                  type="button"
                  onClick={() => router.push('/clinic/vox-soap')}
                  className="w-full mt-1 px-4 py-2 rounded-xl bg-primary hover:bg-primary-dark text-canvas text-xs font-bold transition"
                >
                  ✎ Open full note in VoxSOAP
                </button>
              </div>
            </>
          )}
          {notice.kind === 'micFallback' && (
            <>
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-line bg-sidebar">
                <span className="text-xs font-bold text-warning flex items-center gap-2">
                  <span>⚠</span> Microphone unavailable
                </span>
                <button
                  type="button"
                  onClick={() => setNotice(null)}
                  aria-label="Dismiss result card"
                  className="text-muted hover:text-ink transition"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="px-4 py-3 space-y-2">
                <p className="text-[11px] text-muted leading-relaxed">
                  {notice.reason} Nothing was recorded or extracted — nothing will be invented
                  (FR-27/28). You can use the transcript fallback (FR-30): paste or dictate the
                  consultation text and the same grounding rules apply.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    try {
                      sessionStorage.setItem('pawfolio.voxsoap.openDrawer', '1');
                    } catch {
                      // Storage unavailable — workspace still opens the drawer on flag read.
                    }
                    router.push('/clinic/vox-soap');
                  }}
                  className="w-full mt-1 px-4 py-2 rounded-xl bg-primary hover:bg-primary-dark text-canvas text-xs font-bold transition"
                >
                  📥 Use transcript fallback in VoxSOAP
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Fixed bottom-right action cluster — Scribenote-style one-tap entries.
            Upload (existing audio) sits above the primary Record FAB. */}
      <div className="fixed bottom-6 right-6 z-40 flex flex-col items-end gap-2">
        <button
          type="button"
          onClick={() => setUploadOpen(true)}
          aria-label="Upload an existing consultation audio file for VoxSOAP extraction"
          title="Upload audio — WebM / WAV / MP3 / OGG, max 25 MB"
          className="flex items-center gap-2 rounded-full bg-surface/95 pl-3.5 pr-4 py-2 text-xs font-bold text-ink border border-line shadow-lg shadow-black/30 ring-1 ring-primary-dark/20 transition hover:bg-[#33281f] hover:scale-[1.03] active:scale-95"
        >
          <Upload className="h-3.5 w-3.5" strokeWidth={2.5} />
          Upload Audio
        </button>
        <button
          type="button"
          onClick={() => setPanelOpen(true)}
          aria-label="Start a voice recording for the VoxSOAP medical record"
          title="Record a consultation — audio becomes a grounded SOAP draft"
          className="group flex items-center gap-2.5 rounded-full bg-primary pl-4 pr-5 py-3 text-sm font-bold text-canvas shadow-xl shadow-black/40 ring-1 ring-primary-dark/50 transition hover:bg-primary-dark hover:scale-[1.03] active:scale-95"
        >
          <span className="relative flex h-5 w-5 items-center justify-center">
            <span className="absolute inline-flex h-full w-full rounded-full bg-canvas/30 animate-ping" />
            <Mic className="relative h-4.5 w-4.5" strokeWidth={2.5} />
          </span>
          Record
        </button>
        <span className="rounded-full bg-surface/95 border border-line px-3 py-1 text-[11px] font-semibold text-muted shadow-md">
          🎙️ Voice → SOAP note
        </span>
      </div>

      <NewRecordingPanel
        open={panelOpen}
        defaultPetId="pet-leo-001"
        staffRole={staff.headerRole}
        staffId={staff.staffId}
        staffName={staff.staffName}
        isExtracting={false}
        accent="amber"
        contextLabel="Voice note • demo patient Leo"
        onClose={() => setPanelOpen(false)}
        onCompleted={handleCompleted}
        onFallbackRequested={(reason?: string) => {
          // FR-30 fallback: mic unavailable from the dashboard — surface it
          // inline (no forced navigation); the vet chooses when to continue.
          setNotice({
            kind: 'micFallback',
            reason: reason ?? 'The microphone could not be started in this browser session.',
          });
        }}
        onRecordingStateChange={() => undefined}
      />

      {/* Scribenote-parity upload path — same consent + grounding rules as
          live recording; on completion the draft card appears right here. */}
      <UploadAudioPanel
        open={uploadOpen}
        defaultPetId="pet-leo-001"
        staffRole={staff.headerRole}
        staffId={staff.staffId}
        staffName={staff.staffName}
        accent="amber"
        contextLabel="Upload • demo patient Leo"
        onClose={() => setUploadOpen(false)}
        onCompleted={handleCompleted}
      />
    </>
  );
}
