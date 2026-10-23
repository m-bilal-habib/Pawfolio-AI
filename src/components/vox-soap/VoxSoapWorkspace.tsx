// File: d:\Pawfolio AI\src\components\vox-soap\VoxSoapWorkspace.tsx
'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import type {
  ClinicStaffRole,
  PatientSnapshotContext,
  ValidatedMedicationOrderDraft,
  VoxSoapAuditEvent,
  VoxSoapVisitRecord,
} from '@/lib/vox-soap/vox-soap.types';
import { NewRecordingPanel } from './NewRecordingPanel';
import { UploadAudioPanel } from './UploadAudioPanel';
import { RichTextEditor } from './RichTextEditor';
import { escapePlainToRichHtml } from '@/lib/vox-soap/vox-soap.richtext';
import { VOX_SOAP_STAFF } from '@/lib/vox-soap/vox-soap.staff';
import { useAuth } from '@/lib/auth';
import { WORKFLOW_STATUS_LABELS } from '@/lib/vox-soap/vox-soap.workflow';

/**
 * VoxSOAP note workspace — Scribenote-style editor, reskinned to the Pawfolio
 * system palette (canvas/surface/sidebar/line/primary/accent) so it matches the
 * dashboard and other portal pages.
 *
 * Data rule: EVERY-THING rendered is driven by the real clinic store
 * (/api/clinic/vox-soap/state) or the freshly returned visit from
 * record/upload/extract. There are no seeded demo notes, no hardcoded exam
 * values, and no fake timers — sections without data show explicit empty
 * guidance instead of invented clinical content (FR-27/28 applies to the UI too).
 */

const OBJECTIVE_LABELS: Array<{ key: string; label: string }> = [
  { key: 'temperature', label: 'Temperature' },
  { key: 'heart_rate', label: 'Heart Rate' },
  { key: 'weight_kg', label: 'Weight' },
  { key: 'respiratory_rate', label: 'Respiratory Rate' },
  { key: 'capillary_refill_time', label: 'Capillary Refill Time' },
  { key: 'mucous_membranes', label: 'Mucous Membranes' },
  { key: 'hydration_status', label: 'Hydration Status' },
  { key: 'body_condition_score', label: 'Body Condition Score' },
  { key: 'pain_score', label: 'Pain Score' },
  { key: 'fear_anxiety_stress_score', label: 'Fear Anxiety Stress Score' },
  { key: 'eyes', label: 'Eyes' },
  { key: 'ears', label: 'Ears' },
  { key: 'nasal', label: 'Nasal' },
  { key: 'oral_dental', label: 'Oral/Dental' },
  { key: 'cardiovascular', label: 'Cardiovascular' },
  { key: 'respiratory', label: 'Respiratory' },
  { key: 'neurological', label: 'Neurological' },
  { key: 'musculoskeletal', label: 'Musculoskeletal' },
  { key: 'lymphatic', label: 'Lymphatic' },
  { key: 'gastrointestinal', label: 'Gastrointestinal' },
  { key: 'reproductive_urinary', label: 'Reproductive/Urinary' },
  { key: 'integument', label: 'Integument' },
  { key: 'masses', label: 'Masses' },
];

/** sessionStorage key used by the dashboard to hand over the fresh draft. */
const SELECT_VISIT_KEY = 'pawfolio.voxsoap.selectVisit';

export const VoxSoapWorkspace: React.FC<{ defaultPetId?: string }> = ({
  defaultPetId = 'pet-leo-001',
}) => {
  // FR-1/FR-6: the signed-in profile IS the identity used everywhere. The
  // auth gate is role-based demo auth (see src/lib/auth.tsx), so the role
  // resolves the real profile name — never a hardcoded persona like "Dr. B".
  const { clinicRole } = useAuth();
  const staffProfile = clinicRole ? VOX_SOAP_STAFF[clinicRole] : undefined;
  const staffRole = (staffProfile?.headerRole ?? 'veterinarian') as ClinicStaffRole;
  const staffId = staffProfile?.staffId ?? 'dr.ahmed@pawfolio.ai';
  const staffName = staffProfile?.staffName ?? 'Dr. Ahmed';

  const [snapshot, setSnapshot] = useState<PatientSnapshotContext | null>(null);
  const [visitHistory, setVisitHistory] = useState<VoxSoapVisitRecord[]>([]);
  const [activeVisit, setActiveVisit] = useState<VoxSoapVisitRecord | null>(null);
  const [editableOrders, setEditableOrders] = useState<ValidatedMedicationOrderDraft[]>([]);
  const [auditTrail, setAuditTrail] = useState<VoxSoapAuditEvent[]>([]);

  const [visitTitle, setVisitTitle] = useState<string>('');
  const [visitTimestamp, setVisitTimestamp] = useState<string>('');
  const [additionalNotes, setAdditionalNotes] = useState<string>('');
  const [transcriptInput, setTranscriptInput] = useState<string>('');
  const [showTranscriptDrawer, setShowTranscriptDrawer] = useState<boolean>(false);
  const [openAccordion, setOpenAccordion] = useState<'attachments' | 'export' | 'client' | null>(
    null
  );
  const [feedbackChoice, setFeedbackChoice] = useState<'great' | 'better' | null>(null);

  // Scribenote-parity manual rich-text edits per SOAP section (clinician-
  // authored layer; AI-grounded fields are never overwritten by the UI).
  const sectionEditsRef = useRef<Record<string, string>>({});
  const [hasUnsavedEdits, setHasUnsavedEdits] = useState<boolean>(false);
  const [objectiveMentionedOnly, setObjectiveMentionedOnly] = useState<boolean>(false);
  const handleSectionHtmlChange = useCallback(
    (key: string, html: string) => {
      sectionEditsRef.current[key] = html;
      setHasUnsavedEdits(true);
    },
    []
  );

  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recordingSeconds, setRecordingSeconds] = useState<number>(0);
  const [isExtracting, setIsExtracting] = useState<boolean>(false);
  const [isConfirming, setIsConfirming] = useState<boolean>(false);
  const [recordingPanelOpen, setRecordingPanelOpen] = useState<boolean>(false);
  const [uploadPanelOpen, setUploadPanelOpen] = useState<boolean>(false);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [statusBanner, setStatusBanner] = useState<{
    type: 'success' | 'warning' | 'error' | 'info';
    title: string;
    detail: string;
  } | null>(null);

  // Visits fresh from the dashboard navigation are pre-selected by id.
  const pendingSelectRef = useRef<string | null>(null);

  const syncClinicState = useCallback(async () => {
    try {
      const res = await fetch(`/api/clinic/vox-soap/state?petId=${defaultPetId}`);
      if (!res.ok) return;
      const data = await res.json();
      const visits: VoxSoapVisitRecord[] = data.visits ?? [];
      setSnapshot(data.snapshot);
      setVisitHistory(visits);
      setAuditTrail(data.auditTrail ?? []);

      // 1) Hand-off from the dashboard: select exactly the visit the user
      //    just recorded/uploaded (never a guessed first row).
      let pendingId = pendingSelectRef.current;
      if (!pendingId) {
        try {
          pendingId = sessionStorage.getItem(SELECT_VISIT_KEY);
        } catch {
          // Storage unavailable — fall through to default selection.
        }
      }
      if (pendingId) {
        const target = visits.find((v) => v.visitId === pendingId);
        if (target) {
          setActiveVisit(target);
          setEditableOrders(target.plan.medication_orders);
          pendingSelectRef.current = null;
          try {
            sessionStorage.removeItem(SELECT_VISIT_KEY);
          } catch {
            // Ignore.
          }
          return;
        }
      }

      // 2) Default: newest visit (state route sorts by updatedAt desc).
      if (!activeVisit && visits.length > 0) {
        setActiveVisit(visits[0]);
        setEditableOrders(visits[0].plan.medication_orders);
      }
    } catch {
      // Silent background sync
    }
  }, [defaultPetId, activeVisit]);

  useEffect(() => {
    syncClinicState();
  }, [syncClinicState]);

  // FR-30 fallback hand-off from other surfaces (e.g. dashboard mic failure):
  // a sessionStorage flag asks this workspace to open the transcript drawer.
  useEffect(() => {
    try {
      if (sessionStorage.getItem('pawfolio.voxsoap.openDrawer') === '1') {
        sessionStorage.removeItem('pawfolio.voxsoap.openDrawer');
        setShowTranscriptDrawer(true);
      }
    } catch {
      // sessionStorage unavailable — ignore.
    }
  }, []);

  // Title & timestamp derive from the REAL selected visit (never seeded text).
  useEffect(() => {
    if (!activeVisit) {
      setVisitTitle('');
      setVisitTimestamp('');
      return;
    }
    setVisitTitle(
      `${activeVisit.subjective.pet_name ?? snapshot?.petName ?? 'Patient'}: ${
        activeVisit.subjective.presenting_complaint || 'Consultation'
      }`.slice(0, 90)
    );
    setVisitTimestamp(
      new Date(activeVisit.updatedAt).toLocaleString('en-US', {
        month: '2-digit',
        day: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    );
  }, [activeVisit, snapshot]);

  const handleExtractFromTranscript = async () => {
    setIsExtracting(true);
    setStatusBanner(null);
    try {
      const res = await fetch('/api/clinic/vox-soap/extract', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-staff-role': staffRole,
          'x-staff-id': staffId,
          'x-staff-name': staffName,
          'x-clinic-id': 'clinic-lhr-01',
        },
        body: JSON.stringify({
          petId: defaultPetId,
          transcript: transcriptInput,
        }),
      });

      const payload = await res.json();
      if (!res.ok) {
        setStatusBanner({
          type: 'error',
          title: `Extraction Rejected (HTTP ${res.status})`,
          detail: payload.error ?? 'Failed to extract SOAP note.',
        });
        await syncClinicState();
        return;
      }

      setActiveVisit(payload.visit);
      setEditableOrders(payload.visit.plan.medication_orders);
      setStatusBanner({
        type: 'info',
        title: `Medical Record Generated (${payload.visit.sourceType}) — REVIEW Required`,
        detail:
          'AI draft is isolated in Draft state (FR-29). Inspect the Plan card below to resolve any flagged drug alerts before clicking Mark as Done.',
      });
      await syncClinicState();
    } catch (err) {
      setStatusBanner({
        type: 'error',
        title: 'API Connection Error',
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsExtracting(false);
    }
  };

  const handleAcceptSuggestedDrug = (index: number, canonicalDrug: string) => {
    setEditableOrders((prev) => {
      const next = [...prev];
      const current = next[index];
      next[index] = {
        ...current,
        medicine_name: canonicalDrug,
        validation: {
          ...current.validation,
          drugValidationStatus: 'MATCH',
          canConfirmOrder:
            current.validation.isComplete && !current.validation.allergyConflictDetected,
        },
      };
      return next;
    });
  };

  const handleUpdateOrderField = (
    index: number,
    field: keyof ValidatedMedicationOrderDraft,
    value: string
  ) => {
    setEditableOrders((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const handleSaveEdits = useCallback(async () => {
    if (!activeVisit || activeVisit.recordState !== 'Draft') return;
    setIsConfirming(true);
    try {
      const res = await fetch('/api/clinic/vox-soap/draft-save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-staff-role': staffRole,
          'x-staff-id': staffId,
          'x-staff-name': staffName,
          'x-clinic-id': 'clinic-lhr-01',
        },
        body: JSON.stringify({
          visitId: activeVisit.visitId,
          sectionEdits: {
            subjective: sectionEditsRef.current.subjective ?? '',
            objective: sectionEditsRef.current.objective ?? '',
            assessment: sectionEditsRef.current.assessment ?? '',
            plan: sectionEditsRef.current.plan ?? '',
          },
        }),
      });
      const payload = await res.json();
      if (!res.ok) {
        setStatusBanner({
          type: 'error',
          title: `Save Edits Blocked (HTTP ${res.status})`,
          detail: payload.error ?? 'Manual edits can only be saved on a draft note.',
        });
        await syncClinicState();
        return;
      }
      setActiveVisit(payload.visit);
      setHasUnsavedEdits(false);
      sectionEditsRef.current = {
        ...sectionEditsRef.current,
        ...(payload.visit.sectionEdits ?? {}),
      };
      setStatusBanner({
        type: 'success',
        title: 'Note Edits Saved',
        detail: `Rich-text changes recorded as clinician-authored edits (${payload.visit.sectionEdits?.editedBy ?? staffName}) and audited (Note edited).`,
      });
      await syncClinicState();
    } catch (err) {
      setStatusBanner({
        type: 'error',
        title: 'Save Edits Failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsConfirming(false);
    }
  }, [activeVisit, staffRole, staffId, staffName, syncClinicState]);

  const handleMarkAsDoneConfirm = async () => {
    if (!activeVisit) return;
    // Manual rich-text edits must land BEFORE sign-off so the verified record
    // contains exactly what the clinician reviewed (Scribenote: save then submit).
    if (hasUnsavedEdits) {
      await handleSaveEdits();
    }
    setIsConfirming(true);
    setStatusBanner(null);
    try {
      const res = await fetch('/api/clinic/vox-soap/confirm', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-staff-role': staffRole,
          'x-staff-id': staffId,
          'x-clinic-id': 'clinic-lhr-01',
        },
        body: JSON.stringify({
          visitId: activeVisit.visitId,
          correctedMedicationOrders: editableOrders.map((o) => ({
            medicine_name: o.medicine_name,
            dose_amount: o.dose_amount,
            route: o.route,
            frequency: o.frequency,
            duration: o.duration,
            start_date: o.start_date,
            owner_instructions: o.owner_instructions,
            source_quote: o.source_quote,
            extraction_confidence: o.extraction_confidence,
          })),
        }),
      });

      const payload = await res.json();
      if (!res.ok) {
        const blockedSummary = payload.blockedOrders
          ? payload.blockedOrders
              .map(
                (b: ValidatedMedicationOrderDraft) =>
                  `"${b.medicine_name ?? 'Missing'}" [${b.validation.drugValidationStatus}]`
              )
              .join(', ')
          : '';
        setStatusBanner({
          type: 'error',
          title: `Mark as Done Blocked (HTTP ${res.status})`,
          detail: `${payload.error}${blockedSummary ? ` — Blocked: ${blockedSummary}` : ''}`,
        });
        await syncClinicState();
        return;
      }

      setActiveVisit(payload.visit);
      setEditableOrders(payload.visit.plan.medication_orders);
      setOpenAccordion('client');
      setStatusBanner({
        type: 'success',
        title: `Medical Record Verified & Signed Off (v${payload.visit.version})`,
        detail: `Signed by ${staffName}. Generated ${payload.visit.generatedCareCards.length} deterministic Care Card(s) in Client Summary below.`,
      });
      await syncClinicState();
    } finally {
      setIsConfirming(false);
    }
  };

  // Scribenote parity: "Export" is allowed only from Ready to Export / Exported.
  const handleExportNote = async () => {
    if (!activeVisit) return;
    setIsExporting(true);
    setStatusBanner(null);
    try {
      const res = await fetch('/api/clinic/vox-soap/export', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-staff-role': staffRole,
          'x-staff-id': staffId,
          'x-clinic-id': 'clinic-lhr-01',
        },
        body: JSON.stringify({ visitId: activeVisit.visitId }),
      });
      const payload = await res.json();
      if (!res.ok) {
        setStatusBanner({
          type: 'error',
          title: `Export Blocked (HTTP ${res.status})`,
          detail: payload.error ?? 'Export requires a Marked-as-Done (Verified) note.',
        });
        await syncClinicState();
        return;
      }
      setActiveVisit(payload.visit);
      try {
        await navigator.clipboard.writeText(payload.exportText);
      } catch {
        // Clipboard may be unavailable — export remains recorded server-side.
      }
      setStatusBanner({
        type: 'success',
        title: `Note Exported (export #${payload.visit.exportCount})`,
        detail: 'Scribenote-style status: Exported. Formatted SOAP copied to clipboard — re-export is allowed.',
      });
      await syncClinicState();
    } finally {
      setIsExporting(false);
    }
  };

  // Scribenote parity: "Unmark as Done" returns the note to Available for
  // Review and deterministically cancels published dose events (FR-20).
  const handleUnmarkNote = async () => {
    if (!activeVisit) return;
    setIsConfirming(true);
    setStatusBanner(null);
    try {
      const res = await fetch('/api/clinic/vox-soap/unmark', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-staff-role': staffRole,
          'x-staff-id': staffId,
          'x-clinic-id': 'clinic-lhr-01',
        },
        body: JSON.stringify({ visitId: activeVisit.visitId }),
      });
      const payload = await res.json();
      if (!res.ok) {
        setStatusBanner({
          type: 'error',
          title: `Unmark Blocked (HTTP ${res.status})`,
          detail: payload.error ?? 'Only a Verified (Marked as Done) note can be unmarked.',
        });
        await syncClinicState();
        return;
      }
      setActiveVisit(payload.visit);
      setEditableOrders(payload.visit.plan.medication_orders);
      setStatusBanner({
        type: 'info',
        title: 'Unmarked as Done — back to Available for Review',
        detail:
          'Published care events were cancelled deterministically (FR-20); re-generate them by signing off again.',
      });
      await syncClinicState();
    } finally {
      setIsConfirming(false);
    }
  };

  // Recorder/upload panel completion -> select the fresh draft (status pill
  // and grounding warnings included).
  const handlePanelRecorded = useCallback((visit: VoxSoapVisitRecord) => {
    setActiveVisit(visit);
    setEditableOrders(visit.plan.medication_orders);
    setOpenAccordion('client');
    setStatusBanner({
      type: 'info',
      title: `Draft Ready — ${WORKFLOW_STATUS_LABELS[visit.workflowStatus ?? 'AvailableForReview']}`,
      detail: visit.groundingAuditNote
        ? `Grounding filter applied: ${visit.groundingAuditNote}`
        : 'Grounding verified: every claim traces verbatim to your transcript. Review the note, then Mark as Done.',
    });
  }, []);

  const handlePanelFallback = useCallback(() => {
    setShowTranscriptDrawer(true);
  }, []);

  const handlePanelRecordingState = useCallback((recording: boolean, secs: number) => {
    setIsRecording(recording);
    setRecordingSeconds(secs);
  }, []);

  const copyText = (text: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(text);
    }
  };

  // Derived — only from the real visit; empty without one.
  const subjectiveNarrative = activeVisit
    ? `${activeVisit.subjective.pet_name ?? snapshot?.petName ?? 'Patient'}${
        activeVisit.subjective.age_mentioned ? ` (${activeVisit.subjective.age_mentioned})` : ''
      } — presenting complaint: ${activeVisit.subjective.presenting_complaint}${
        activeVisit.subjective.symptom_duration
          ? ` · Duration: ${activeVisit.subjective.symptom_duration}`
          : ''
      }${
        activeVisit.subjective.previous_medical_history
          ? ` · History: ${activeVisit.subjective.previous_medical_history}`
          : ''
      }`
    : '';

  // Rich-text editors (Scribenote edit view parity): saved clinician edits
  // win; otherwise the grounded draft text seeds the Subjective/Assessment
  // editors so the vet restyles the real note, never a blank canvas.
  const editorLockReason =
    activeVisit && activeVisit.recordState !== 'Draft'
      ? 'This note is signed off — it is read-only. Use "Unmark as Done" to edit it again.'
      : null;
  const subjectiveEditorHtml = activeVisit
    ? activeVisit.sectionEdits?.subjective ?? escapePlainToRichHtml(subjectiveNarrative)
    : '';
  const objectiveEditorHtml = activeVisit?.sectionEdits?.objective ?? '';
  const assessmentEditorHtml = activeVisit
    ? activeVisit.sectionEdits?.assessment ??
      escapePlainToRichHtml(
        [
          ...activeVisit.assessment.diagnoses_and_findings.map(
            (d) => `${d.condition} — ${d.clinical_reasoning}`
          ),
          activeVisit.assessment.vaccination_status_notes
            ? `Vaccination status: ${activeVisit.assessment.vaccination_status_notes}`
            : '',
        ]
          .filter(Boolean)
          .join('\n')
      )
    : '';
  const planEditorHtml = activeVisit?.sectionEdits?.plan ?? '';

  const audioMeta = activeVisit
    ? [
        activeVisit.workflowRecording.audioSizeBytes
          ? `${(activeVisit.workflowRecording.audioSizeBytes / (1024 * 1024)).toFixed(2)} MB`
          : null,
        activeVisit.workflowRecording.audioMimeType ?? null,
        activeVisit.workflowRecording.consentAt ? 'consent logged' : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;

  const recordStatePillClass =
    activeVisit?.recordState === 'Verified'
      ? 'bg-success/15 text-success border-success/40'
      : activeVisit?.recordState === 'Superseded'
      ? 'bg-surface text-muted border-line'
      : 'bg-accent/15 text-accent border-accent/40';

  const workflowPillClass = (() => {
    switch (activeVisit?.workflowStatus) {
      case 'ReadyToExport':
        return 'bg-success/15 text-success border-success/40';
      case 'Exported':
        return 'bg-primary/15 text-primary-dark border-primary/40';
      case 'Failed':
        return 'bg-error/15 text-error border-error/40';
      case 'Transcribing':
        return 'bg-accent/15 text-accent border-accent/40 animate-pulse';
      case 'Unsynced':
        return 'bg-surface text-muted border-line';
      default:
        return 'bg-accent/15 text-accent border-accent/40';
    }
  })();

  return (
    <div className="min-h-screen flex bg-canvas text-ink font-sans selection:bg-primary/30 selection:text-ink">
      {/* Main Clinical Workspace */}
      <div className="flex-1 flex flex-col min-w-0 pb-28">
        {/* Top Navigation Bar */}
        <header className="px-6 py-4 flex flex-wrap items-center justify-between gap-4 border-b border-line bg-canvas/90 backdrop-blur sticky top-0 z-30">
          <div className="flex items-center gap-3">
            <span className="text-2xl font-display font-extrabold tracking-tight text-ink">
              Pawfolio<span className="text-primary ml-1.5 text-lg font-sans font-bold">VoxSOAP</span>
            </span>
            {snapshot && (
              <span className="px-3 py-1 rounded-full text-xs font-semibold bg-primary/15 text-primary border border-primary/30">
                {snapshot.petName} • {snapshot.ageYears}y •{' '}
                {snapshot.knownAllergies.length > 0
                  ? `Allergies: ${snapshot.knownAllergies.join(', ')}`
                  : 'No allergies on file'}
              </span>
            )}
          </div>

          <div className="flex items-center gap-4">
            {/* Real signed-in profile (FR-1) — the auth gate's role IS the
                identity; no in-workspace role impersonation switcher. */}
            <div className="flex items-center gap-2 text-sm font-semibold text-ink">
              <span className="px-2.5 py-1 rounded-full bg-primary/15 text-primary border border-primary/30 text-xs font-bold capitalize">
                {clinicRole ?? 'guest'}
              </span>
              <span>▾ {staffName}</span>
              <div className="w-9 h-9 rounded-full bg-primary/20 text-primary flex items-center justify-center font-bold">
                {staffName.replace(/^Dr\.\s*/i, '').charAt(0) || '👤'}
              </div>
            </div>
          </div>
        </header>

        {/* Main Content Container */}
        <main className="max-w-5xl w-full mx-auto px-4 sm:px-8 pt-6 space-y-6">
          <h1 className="font-display text-2xl sm:text-3xl font-extrabold tracking-tight text-ink">
            {activeVisit ? 'Edit Note' : 'Medical Notes'}
          </h1>

          {/* Sticky Medical Record Header & Transcript Pill Bar */}
          <div className="bg-surface border border-line rounded-2xl p-4 sm:p-5 shadow-md space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-7 h-7 rounded-md bg-primary flex items-center justify-center font-bold text-canvas">
                  +
                </div>
                <span className="text-xl sm:text-2xl font-display font-extrabold text-ink">
                  Medical Record
                </span>
                <span
                  className={`px-3 py-0.5 rounded-full text-xs font-bold uppercase tracking-wide border ${recordStatePillClass}`}
                >
                  {activeVisit ? `${activeVisit.recordState} (v${activeVisit.version})` : 'REVIEW'}
                </span>
                {/* Scribenote-style pipeline pill: where this note is in
                    Unsynced → Transcribing → Available for Review → Ready to
                    Export → Exported (IS-13 workflow layer). */}
                {activeVisit && (
                  <span
                    className={`px-3 py-0.5 rounded-full text-xs font-bold uppercase tracking-wide border ${workflowPillClass}`}
                  >
                    {WORKFLOW_STATUS_LABELS[activeVisit.workflowStatus ?? 'AvailableForReview']}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-4 text-xs text-muted font-medium">
                <span>
                  {activeVisit
                    ? `✓ ${activeVisit.sourceType.replace(/_/g, ' ')}`
                    : 'No note processed yet'}
                </span>
                {audioMeta && <span>🎧 {audioMeta} · scrubbed after transcription</span>}
              </div>
            </div>

            {/* Transcript Pill + New Recording / Upload Buttons */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-[260px] bg-sidebar border border-line rounded-full px-4 py-2.5 flex items-center gap-3">
                <div className="w-7 h-7 rounded-full flex items-center justify-center bg-primary/20 text-primary text-sm">
                  🎧
                </div>
                <span className="text-xs font-semibold font-mono shrink-0 text-muted">
                  {activeVisit && audioMeta ? audioMeta : 'No audio processed yet'}
                </span>
                <div className="flex-1 h-1.5 bg-canvas rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all ${
                      isRecording ? 'w-full bg-error animate-pulse' : activeVisit ? 'w-1/3 bg-primary' : 'w-0'
                    }`}
                  />
                </div>
                <span className="text-[11px] text-muted shrink-0 hidden sm:block">
                  Deleted_After_Transcription
                </span>
              </div>

              <button
                type="button"
                onClick={handleExtractFromTranscript}
                disabled={isExtracting || transcriptInput.trim().length < 10}
                title="Extract Grounded SOAP Draft from Consultation Transcript (FR-30 fallback)"
                className="w-10 h-10 rounded-full bg-primary hover:bg-primary-dark text-canvas flex items-center justify-center shadow-md transition disabled:opacity-40 font-bold"
              >
                {isExtracting ? '…' : '✨'}
              </button>

              {!isRecording ? (
                <button
                  type="button"
                  onClick={() => setRecordingPanelOpen(true)}
                  disabled={isExtracting}
                  title="Dedicated New Recording panel (capture-hardened)"
                  className="px-4 py-2.5 rounded-full bg-primary hover:bg-primary-dark text-canvas font-bold text-sm flex items-center gap-2 shadow-md transition"
                >
                  <span>🎙️</span>
                  <span>New Recording</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setRecordingPanelOpen(true)}
                  className="px-4 py-2.5 rounded-full bg-error hover:bg-error/90 text-canvas font-bold text-sm flex items-center gap-2 animate-pulse shadow-md"
                >
                  <span>⏺</span>
                  <span>LIVE ({recordingSeconds}s)</span>
                </button>
              )}

              {/* Scribenote parity: web-only audio upload path. Client-side
                  validation mirrors the server (MIME whitelist + 25 MB, NFR-3). */}
              <button
                type="button"
                onClick={() => setUploadPanelOpen(true)}
                disabled={isRecording || isExtracting}
                title="Upload an existing consultation audio file (WebM / WAV / MP3 / M4A / AAC / OGG / FLAC, max 25 MB)"
                className="px-4 py-2.5 rounded-full bg-sidebar hover:bg-[#33281f] text-ink font-bold text-sm flex items-center gap-2 border border-line shadow-md transition disabled:opacity-40"
              >
                <span>📎</span>
                <span>Upload Audio</span>
              </button>
            </div>

            {/* Metadata Inputs & Sign-off / Export Row */}
            <div className="flex flex-wrap items-center gap-2.5 pt-1">
              <input
                type="text"
                value={visitTitle}
                onChange={(e) => setVisitTitle(e.target.value)}
                placeholder="Note title (derived from the extracted record)"
                className="flex-1 min-w-[240px] bg-canvas border border-line rounded-full px-4 py-2 text-xs sm:text-sm text-ink font-medium placeholder:text-muted focus:outline-none"
              />
              <div className="bg-canvas border border-line rounded-full px-4 py-2 text-xs sm:text-sm text-muted flex items-center gap-2">
                <input
                  type="text"
                  value={visitTimestamp}
                  onChange={(e) => setVisitTimestamp(e.target.value)}
                  placeholder="—"
                  className="bg-transparent focus:outline-none w-36 placeholder:text-muted"
                />
                <span>📅</span>
              </div>

              <div className="flex items-center rounded-lg overflow-hidden border border-line text-xs font-bold">
                <button
                  type="button"
                  onClick={handleSaveEdits}
                  disabled={
                    isConfirming || !activeVisit || activeVisit.recordState !== 'Draft'
                  }
                  className="px-3.5 py-2.5 bg-sidebar hover:bg-[#33281f] text-ink flex items-center gap-1.5 transition disabled:opacity-40"
                  title="Save manual rich-text edits on this draft note (clinician-authored layer, audited)"
                >
                  <span>💾</span>
                  <span>
                    {isConfirming ? 'Saving...' : hasUnsavedEdits ? '• Save Edits' : 'Save Edits'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={handleMarkAsDoneConfirm}
                  disabled={isConfirming || !activeVisit}
                  className="px-3.5 py-2.5 bg-success hover:bg-success/85 text-canvas flex items-center gap-1.5 transition disabled:opacity-40"
                >
                  <span>✓</span>
                  <span>
                    {isConfirming
                      ? 'Verifying...'
                      : activeVisit?.recordState === 'Verified'
                      ? 'Supersede (v+1)'
                      : 'Mark as Done'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowTranscriptDrawer((prev) => !prev)}
                  className="px-3 py-2.5 bg-sidebar hover:bg-[#33281f] text-muted flex items-center gap-1.5 transition"
                >
                  <span>📥</span>
                  <span>Transcript</span>
                </button>
                {/* Scribenote parity: Unmark as Done returns a signed-off note
                    to Available for Review (care events cancelled, FR-20). */}
                {activeVisit &&
                  (activeVisit.recordState === 'Verified' ||
                    activeVisit.workflowStatus === 'Exported') && (
                    <button
                      type="button"
                      onClick={handleUnmarkNote}
                      disabled={isConfirming}
                      className="px-3 py-2.5 bg-sidebar hover:bg-[#33281f] text-warning flex items-center gap-1.5 transition disabled:opacity-40"
                    >
                      <span>↩</span>
                      <span>{isConfirming ? 'Unmarking…' : 'Unmark as Done'}</span>
                    </button>
                  )}
                {/* Scribenote parity: Export allowed only from Ready to Export
                    / Exported; Exported notes may be re-exported. */}
                {activeVisit &&
                  (activeVisit.workflowStatus === 'ReadyToExport' ||
                    activeVisit.workflowStatus === 'Exported') && (
                    <button
                      type="button"
                      onClick={handleExportNote}
                      disabled={isExporting}
                      className="px-3 py-2.5 bg-accent hover:bg-accent-dark text-canvas flex items-center gap-1.5 transition disabled:opacity-40"
                    >
                      <span>📤</span>
                      <span>
                        {isExporting
                          ? 'Exporting…'
                          : activeVisit.workflowStatus === 'Exported'
                          ? 'Re-Export'
                          : 'Export'}
                      </span>
                    </button>
                  )}
              </div>
            </div>

            {/* Version History Switcher if multiple versions exist */}
            {visitHistory.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-line text-xs">
                <span className="text-muted font-semibold">Version History:</span>
                {visitHistory.map((v) => (
                  <button
                    key={v.visitId}
                    type="button"
                    onClick={() => {
                      setActiveVisit(v);
                      setEditableOrders(v.plan.medication_orders);
                    }}
                    title={`${v.visitId} · ${v.sourceType}`}
                    className={`px-2.5 py-1 rounded-full font-mono transition ${
                      activeVisit?.visitId === v.visitId
                        ? 'bg-primary text-canvas font-bold'
                        : 'bg-canvas text-muted border border-line hover:text-ink'
                    }`}
                  >
                    v{v.version} · {WORKFLOW_STATUS_LABELS[v.workflowStatus ?? 'AvailableForReview']} ·{' '}
                    {new Date(v.updatedAt).toLocaleTimeString('en-US', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Dynamic Status Banner */}
          {statusBanner && (
            <div
              className={`rounded-xl p-4 border text-xs sm:text-sm space-y-1 shadow-lg ${
                statusBanner.type === 'success'
                  ? 'bg-success/10 border-success/50 text-ink'
                  : statusBanner.type === 'error'
                  ? 'bg-error/10 border-error/50 text-ink'
                  : statusBanner.type === 'warning'
                  ? 'bg-warning/10 border-warning/50 text-ink'
                  : 'bg-primary/10 border-primary/50 text-ink'
              }`}
            >
              <div className="font-bold">{statusBanner.title}</div>
              <div className="opacity-90 text-muted">{statusBanner.detail}</div>
            </div>
          )}

          {/* Empty state — no invented demo record; capture CTAs only. */}
          {!activeVisit && (
            <section className="rounded-2xl border border-line bg-surface p-10 text-center space-y-4">
              <div className="text-5xl">🎙️</div>
              <h2 className="font-display text-xl font-bold text-ink">No consultation notes yet</h2>
              <p className="max-w-xl mx-auto text-sm text-muted leading-relaxed">
                Everything in this workspace is grounded in a real consultation. Record live audio
                or upload an existing audio file — Gemini transcribes it, every claim is verified
                verbatim against the transcript, and unspoken exam fields stay &ldquo;Not
                mentioned&rdquo; (FR-27/28).
              </p>
              <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setRecordingPanelOpen(true)}
                  className="px-5 py-2.5 rounded-xl bg-primary hover:bg-primary-dark text-canvas font-bold text-sm"
                >
                  🎙️ New Recording
                </button>
                <button
                  type="button"
                  onClick={() => setUploadPanelOpen(true)}
                  className="px-5 py-2.5 rounded-xl bg-sidebar hover:bg-[#33281f] text-ink font-bold text-sm border border-line"
                >
                  📎 Upload Audio
                </button>
              </div>
            </section>
          )}

          {activeVisit && (
            <>
              {/* S — SUBJECTIVE */}
              <section className="rounded-2xl overflow-hidden border border-line bg-surface shadow-md">
                <div className="bg-sidebar px-4 py-3 flex items-center justify-between border-b border-line">
                  <div className="flex items-center gap-3">
                    <span className="w-8 h-8 rounded-lg bg-accent/15 text-accent flex items-center justify-center font-display font-extrabold">
                      S
                    </span>
                    <h2 className="font-display font-bold text-ink">Subjective</h2>
                    <span className="hidden sm:inline text-xs text-muted">
                      History — verbatim quoted or empty (FR-28)
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => copyText(subjectiveNarrative)}
                    className="w-8 h-8 rounded-lg bg-canvas hover:bg-[#33281f] border border-line flex items-center justify-center text-xs"
                    title="Copy Subjective Note"
                  >
                    📋
                  </button>
                </div>
                <div className="p-4 sm:p-5 space-y-3">
                  <RichTextEditor
                    sectionKey="subjective"
                    sectionLabel="Subjective"
                    initialHtml={subjectiveEditorHtml}
                    placeholder="History — verbatim quoted or empty (FR-28)…"
                    visitId={activeVisit.visitId}
                    staffHeaders={{ role: staffRole, id: staffId, name: staffName }}
                    onHtmlChange={(html) => handleSectionHtmlChange('subjective', html)}
                    readOnly={activeVisit.recordState !== 'Draft'}
                  />
                  {editorLockReason && (
                    <div className="text-xs text-muted italic">{editorLockReason}</div>
                  )}
                  {activeVisit.subjective.source_quote ? (
                    <div className="text-xs text-muted italic border-l-2 border-accent pl-3">
                      Grounded Transcript Source: &ldquo;{activeVisit.subjective.source_quote}&rdquo;
                    </div>
                  ) : (
                    <div className="text-xs text-warning italic">
                      History is UNVERIFIED — no verbatim quote for the presenting complaint could
                      be traced back to the transcript (never hallucinated).
                    </div>
                  )}
                </div>
              </section>

              {/* O — OBJECTIVE */}
              <section className="rounded-2xl overflow-hidden border border-line bg-surface shadow-md">
                <div className="bg-sidebar px-4 py-3 flex items-center justify-between border-b border-line">
                  <div className="flex items-center gap-3">
                    <span className="w-8 h-8 rounded-lg bg-primary/15 text-primary flex items-center justify-center font-display font-extrabold">
                      O
                    </span>
                    <h2 className="font-display font-bold text-ink">Objective</h2>
                    <span className="hidden sm:inline text-xs text-muted">
                      FR-28 Null-Safe Grounding (23 parameters)
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {/* Writing Assistant parity: objective filtering — only
                        show documented findings (null-safe on all 23 params). */}
                    <button
                      type="button"
                      onClick={() => setObjectiveMentionedOnly((p) => !p)}
                      className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold border transition ${
                        objectiveMentionedOnly
                          ? 'bg-primary text-canvas border-primary'
                          : 'bg-canvas text-muted border-line hover:text-ink'
                      }`}
                      title="Show only the findings that were actually documented"
                    >
                      {objectiveMentionedOnly ? '✓ Mentioned only' : 'Show all (23)'}
                    </button>
                    <span
                      className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-canvas text-muted border border-line"
                      title={activeVisit.weightCrossCheckNote ?? undefined}
                    >
                      Weight Check: {activeVisit.weightCrossCheckStatus}
                    </span>
                  </div>
                </div>
                <div className="px-5 pt-4 text-xs sm:text-sm leading-6 space-y-0.5">
                  {OBJECTIVE_LABELS.map(({ key, label }) => {
                    const val = activeVisit.objectiveDisplay?.[key] ?? 'Not mentioned';
                    const isMentioned = val !== 'Not mentioned';
                    if (objectiveMentionedOnly && !isMentioned) return null;
                    return (
                      <div
                        key={key}
                        className={isMentioned ? 'text-ink font-semibold' : 'text-muted'}
                      >
                        <span>{label}: </span>
                        <span>{val}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="p-4 sm:p-5 space-y-2">
                  <span className="block text-xs font-bold uppercase tracking-wider text-muted">
                    Exam narrative (free text)
                  </span>
                  <RichTextEditor
                    sectionKey="objective"
                    sectionLabel="Objective"
                    initialHtml={objectiveEditorHtml}
                    placeholder="Free-text exam findings — the structured panel above stays authoritative…"
                    visitId={activeVisit.visitId}
                    staffHeaders={{ role: staffRole, id: staffId, name: staffName }}
                    onHtmlChange={(html) => handleSectionHtmlChange('objective', html)}
                    readOnly={activeVisit.recordState !== 'Draft'}
                    minHeight={64}
                  />
                  {editorLockReason && (
                    <div className="text-xs text-muted italic">{editorLockReason}</div>
                  )}
                </div>
              </section>

              {/* A — ASSESSMENT */}
              <section className="rounded-2xl overflow-hidden border border-line bg-surface shadow-md">
                <div className="bg-sidebar px-4 py-3 flex items-center justify-between border-b border-line">
                  <div className="flex items-center gap-3">
                    <span className="w-8 h-8 rounded-lg bg-success/15 text-success flex items-center justify-center font-display font-extrabold">
                      A
                    </span>
                    <h2 className="font-display font-bold text-ink">Assessment</h2>
                    <span className="hidden sm:inline text-xs text-muted">
                      Only verdicts quoted from the transcript survive grounding
                    </span>
                  </div>
                </div>
                <div className="p-4 sm:p-5 space-y-2">
                  <RichTextEditor
                    sectionKey="assessment"
                    sectionLabel="Assessment"
                    initialHtml={assessmentEditorHtml}
                    placeholder="Assessment narrative — condition reasoning, differentials…"
                    visitId={activeVisit.visitId}
                    staffHeaders={{ role: staffRole, id: staffId, name: staffName }}
                    onHtmlChange={(html) => handleSectionHtmlChange('assessment', html)}
                    readOnly={activeVisit.recordState !== 'Draft'}
                  />
                  {editorLockReason && (
                    <div className="text-xs text-muted italic">{editorLockReason}</div>
                  )}
                  <div className="pt-2 border-t border-line text-[11px] text-muted italic space-y-0.5">
                    <span className="font-bold not-italic">Grounded evidence (FR-27/28):</span>
                    {activeVisit.assessment.diagnoses_and_findings.length > 0 ? (
                      activeVisit.assessment.diagnoses_and_findings.map((d, i) => (
                        <div key={i}>
                          &ldquo;{d.source_quote}&rdquo; → {d.condition}
                        </div>
                      ))
                    ) : (
                      <div>
                        No diagnoses were grounded in the transcript — nothing inferred.
                      </div>
                    )}
                    {activeVisit.assessment.vaccination_status_notes && (
                      <div>
                        Vaccination status note: {activeVisit.assessment.vaccination_status_notes}
                      </div>
                    )}
                  </div>
                </div>
              </section>

              {/* P — PLAN */}
              <section className="rounded-2xl overflow-hidden border border-line bg-surface shadow-md">
                <div className="bg-sidebar px-4 py-3 flex items-center justify-between border-b border-line">
                  <div className="flex items-center gap-3">
                    <span className="w-8 h-8 rounded-lg bg-warning/15 text-warning flex items-center justify-center font-display font-extrabold">
                      P
                    </span>
                    <h2 className="font-display font-bold text-ink">Plan</h2>
                    <span className="hidden sm:inline text-xs text-muted">
                      Deterministic order validation &amp; fuzzy catalog check (FR-10)
                    </span>
                  </div>
                </div>
                <div className="p-5 text-sm space-y-4">
                  <ul className="list-disc pl-5 space-y-1.5 text-ink">
                    {activeVisit.plan.vaccinations_administered.length > 0 && (
                      <li>
                        Administered{' '}
                        {activeVisit.plan.vaccinations_administered.join(' and ')} vaccination
                        {activeVisit.plan.vaccinations_administered.length > 1 ? 's' : ''} today.
                      </li>
                    )}
                    {editableOrders.length > 0 ? (
                      editableOrders.map((ord) => (
                        <li key={ord.orderId}>
                          Prescribed <strong>{ord.medicine_name ?? 'Unspecified'}</strong>
                          {ord.dose_amount ? ` — dose ${ord.dose_amount}` : ''}
                          {ord.route ? `, ${ord.route}` : ''}
                          {ord.frequency ? `, ${ord.frequency}` : ''}
                          {ord.duration ? ` for ${ord.duration}` : ''}
                          {ord.validation.matchedCanonicalDrug &&
                            ord.validation.matchedCanonicalDrug !== ord.medicine_name && (
                              <span className="block text-xs text-muted italic">
                                Catalog match: {ord.validation.matchedCanonicalDrug}
                              </span>
                            )}
                        </li>
                      ))
                    ) : (
                      <li className="text-muted list-none">
                        No medication orders were grounded in this consultation.
                      </li>
                    )}
                    {activeVisit.plan.test_orders.length > 0 && (
                      <li>Tests ordered: {activeVisit.plan.test_orders.join(', ')}.</li>
                    )}
                    {activeVisit.plan.follow_up_date_or_interval && (
                      <li>Follow-up: {activeVisit.plan.follow_up_date_or_interval}.</li>
                    )}
                    {activeVisit.plan.general_care_instructions && (
                      <li>General care: {activeVisit.plan.general_care_instructions}</li>
                    )}
                  </ul>

                  {/* Plan narrative — free rich text above the structured,
                      FR-10 validated order cards (never merged with them). */}
                  <RichTextEditor
                    sectionKey="plan"
                    sectionLabel="Plan"
                    initialHtml={planEditorHtml}
                    placeholder="Plan narrative / extra instructions — structured orders stay below…"
                    visitId={activeVisit.visitId}
                    staffHeaders={{ role: staffRole, id: staffId, name: staffName }}
                    onHtmlChange={(html) => handleSectionHtmlChange('plan', html)}
                    readOnly={activeVisit.recordState !== 'Draft'}
                    minHeight={64}
                  />
                  {editorLockReason && (
                    <div className="text-xs text-muted italic">{editorLockReason}</div>
                  )}

                  {/* Interactive Medication Order Verification Cards */}
                  {editableOrders.length > 0 && (
                    <div className="pt-3 border-t border-line space-y-3">
                      <div className="text-xs font-bold uppercase tracking-wider text-warning">
                        Structured Medication Orders (must be MATCH &amp; complete before Mark as
                        Done — FR-10)
                      </div>
                      {editableOrders.map((order, idx) => {
                        const v = order.validation;
                        return (
                          <div
                            key={order.orderId}
                            className="p-3.5 rounded-xl bg-sidebar border border-line space-y-3"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="font-bold text-xs sm:text-sm text-ink">
                                Order #{idx + 1}: {order.medicine_name ?? 'MISSING NAME'}
                              </span>
                              <span
                                className={`px-2.5 py-0.5 rounded-full text-xs font-bold ${
                                  v.drugValidationStatus === 'MATCH'
                                    ? 'bg-success/15 text-success border border-success/40'
                                    : 'bg-warning/15 text-warning border border-warning/40'
                                }`}
                              >
                                {v.drugValidationStatus}
                              </span>
                            </div>

                            {v.drugValidationStatus === 'NEEDS_REVIEW' && v.matchedCanonicalDrug && (
                              <div className="p-3 rounded-lg bg-canvas border border-warning/50 flex flex-wrap items-center justify-between gap-2 text-xs">
                                <div className="text-ink">
                                  Phonetic typo detected:{' '}
                                  <strong className="text-warning">
                                    &ldquo;{order.medicine_name}&rdquo;
                                  </strong>{' '}
                                  closely matches reviewed catalog entry{' '}
                                  <strong className="text-success">{v.matchedCanonicalDrug}</strong>.
                                </div>
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleAcceptSuggestedDrug(idx, v.matchedCanonicalDrug!)
                                  }
                                  className="px-3 py-1.5 rounded-lg bg-success hover:bg-success/85 text-canvas font-bold transition"
                                >
                                  ✓ Replace with &ldquo;{v.matchedCanonicalDrug}&rdquo;
                                </button>
                              </div>
                            )}

                            <div className="grid grid-cols-1 sm:grid-cols-5 gap-2 text-xs">
                              <input
                                type="text"
                                value={order.medicine_name ?? ''}
                                onChange={(e) =>
                                  handleUpdateOrderField(idx, 'medicine_name', e.target.value)
                                }
                                placeholder="Medicine Name"
                                className="bg-canvas border border-line rounded px-2.5 py-1.5 text-ink placeholder:text-muted"
                              />
                              <input
                                type="text"
                                value={order.dose_amount ?? ''}
                                onChange={(e) =>
                                  handleUpdateOrderField(idx, 'dose_amount', e.target.value)
                                }
                                placeholder="Dose (e.g. 4 drops)"
                                className="bg-canvas border border-line rounded px-2.5 py-1.5 text-ink placeholder:text-muted"
                              />
                              <input
                                type="text"
                                value={order.route ?? ''}
                                onChange={(e) => handleUpdateOrderField(idx, 'route', e.target.value)}
                                placeholder="Route"
                                className="bg-canvas border border-line rounded px-2.5 py-1.5 text-ink placeholder:text-muted"
                              />
                              <input
                                type="text"
                                value={order.frequency ?? ''}
                                onChange={(e) =>
                                  handleUpdateOrderField(idx, 'frequency', e.target.value)
                                }
                                placeholder="Frequency"
                                className="bg-canvas border border-line rounded px-2.5 py-1.5 text-ink placeholder:text-muted"
                              />
                              <input
                                type="text"
                                value={order.duration ?? ''}
                                onChange={(e) =>
                                  handleUpdateOrderField(idx, 'duration', e.target.value)
                                }
                                placeholder="Duration"
                                className="bg-canvas border border-line rounded px-2.5 py-1.5 text-ink placeholder:text-muted"
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </section>

              {/* Clinic free-text (explicitly NOT AI-extracted) */}
              <section className="rounded-2xl overflow-hidden border border-line bg-surface shadow-md">
                <div className="bg-sidebar px-4 py-3 flex items-center justify-between border-b border-line">
                  <h2 className="font-display font-bold text-ink">Additional Notes</h2>
                  <span className="text-xs text-muted">Clinician free-text (not AI-extracted)</span>
                </div>
                <div className="p-4">
                  <textarea
                    rows={2}
                    value={additionalNotes}
                    onChange={(e) => setAdditionalNotes(e.target.value)}
                    placeholder="Any remarks you want attached to this note — these are never auto-generated from the consultation."
                    className="w-full bg-transparent text-sm text-ink placeholder:text-muted focus:outline-none"
                  />
                </div>
              </section>

              {/* AI Note Feedback Prompt */}
              <div className="bg-surface border border-line rounded-2xl px-5 py-4 flex flex-wrap items-center justify-between gap-3">
                <span className="text-sm font-medium text-muted">
                  What did you think of this AI-generated note?
                </span>
                <div className="flex items-center gap-2.5 text-xs font-bold">
                  <button
                    type="button"
                    onClick={() => setFeedbackChoice('great')}
                    className={`px-4 py-2 rounded-full border transition ${
                      feedbackChoice === 'great'
                        ? 'bg-success text-canvas border-success'
                        : 'bg-canvas text-ink border-line hover:border-primary'
                    }`}
                  >
                    🐾 Great!
                  </button>
                  <button
                    type="button"
                    onClick={() => setFeedbackChoice('better')}
                    className={`px-4 py-2 rounded-full border transition ${
                      feedbackChoice === 'better'
                        ? 'bg-warning text-canvas border-warning'
                        : 'bg-canvas text-ink border-line hover:border-primary'
                    }`}
                  >
                    🐾 Could be better.
                  </button>
                </div>
              </div>
            </>
          )}

          {/* Bottom Collapsible Accordions (Client Care Summary, Export/Audit) */}
          <div className="space-y-3">
            {/* 🏠 Client Summary & Deterministic Care Cards */}
            <div className="bg-surface border border-line rounded-xl overflow-hidden">
              <button
                type="button"
                onClick={() => setOpenAccordion(openAccordion === 'client' ? null : 'client')}
                className="w-full px-5 py-4 flex items-center justify-between text-left"
              >
                <div>
                  <div className="font-display font-bold text-base text-ink flex items-center gap-2">
                    <span>🏠</span>
                    <span>Client Summary &amp; Deterministic Care Cards (FR-15 / FR-16)</span>
                  </div>
                  <p className="text-xs text-muted mt-0.5">
                    Generated by fixed rules only after the Veterinarian clicks
                    &ldquo;Mark as Done&rdquo;.
                  </p>
                </div>
                <span className="text-muted">{openAccordion === 'client' ? '▴' : '▾'}</span>
              </button>
              {openAccordion === 'client' && (
                <div className="px-5 pb-5 pt-2 border-t border-line space-y-3">
                  {!activeVisit || activeVisit.generatedCareCards.length === 0 ? (
                    <p className="text-xs text-warning italic">
                      No Care Cards published yet. Review the plan, resolve any NEEDS_REVIEW drug
                      alerts, then click &ldquo;✓ Mark as Done&rdquo; as a Veterinarian.
                    </p>
                  ) : (
                    activeVisit.generatedCareCards.map((card) => (
                      <div
                        key={card.careCardId}
                        className="p-4 rounded-xl bg-sidebar border border-success/40 space-y-2"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-bold text-sm text-success">{card.title}</span>
                          <span className="text-xs font-mono text-muted">
                            {card.frequencySummary}
                          </span>
                        </div>
                        <p className="text-xs text-ink">{card.plainLanguageInstructions}</p>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2">
                          {card.generatedDoseEvents.slice(0, 8).map((ev, i) => (
                            <div
                              key={ev.eventId}
                              className="p-2 rounded bg-canvas text-[11px] font-mono text-muted"
                            >
                              Dose #{i + 1}: {ev.doseAmount} (
                              {new Date(ev.scheduledIsoTimestamp).toLocaleDateString()})
                            </div>
                          ))}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* 📤 Export Note & Provenance Audit Trail */}
            <div className="bg-surface border border-line rounded-xl overflow-hidden">
              <button
                type="button"
                onClick={() => setOpenAccordion(openAccordion === 'export' ? null : 'export')}
                className="w-full px-5 py-4 flex items-center justify-between text-left"
              >
                <div>
                  <div className="font-display font-bold text-base text-ink flex items-center gap-2">
                    <span>📤</span>
                    <span>Export Note &amp; Immutable Provenance Audit Log (FR-26)</span>
                  </div>
                  <p className="text-xs text-muted mt-0.5">
                    Inspect every state transition, role check, and version supersession (
                    {auditTrail.length} events).
                  </p>
                </div>
                <span className="text-muted">{openAccordion === 'export' ? '▴' : '▾'}</span>
              </button>
              {openAccordion === 'export' && (
                <div className="px-5 pb-5 pt-2 border-t border-line space-y-2 max-h-60 overflow-y-auto">
                  {auditTrail.length === 0 ? (
                    <p className="text-xs text-muted italic">No audit events recorded yet.</p>
                  ) : (
                    auditTrail.map((a) => (
                      <div
                        key={a.auditId}
                        className="p-2.5 rounded bg-sidebar border border-line text-xs font-mono flex flex-wrap items-center justify-between gap-2"
                      >
                        <span className="text-ink">
                          <strong className="text-primary">{a.action}</strong> by {a.actorId} (
                          {a.actorRole})
                        </span>
                        <span className="text-success">
                          {a.previousState ?? 'None'} &rarr; {a.newState}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        </main>

        {/* Floating Bottom Center "Show Transcript ^" Drawer Trigger */}
        <div className="fixed bottom-0 left-16 sm:left-20 right-0 z-40 flex flex-col items-center pointer-events-none">
          <button
            type="button"
            onClick={() => setShowTranscriptDrawer((prev) => !prev)}
            className="pointer-events-auto px-6 py-2.5 rounded-t-2xl bg-primary hover:bg-primary-dark text-canvas font-bold text-sm shadow-2xl flex items-center gap-2 border border-b-0 border-primary-dark/50"
          >
            <span>{showTranscriptDrawer ? 'Hide Transcript ▾' : 'Show Transcript ▴'}</span>
          </button>

          {showTranscriptDrawer && (
            <div className="pointer-events-auto w-full max-w-4xl bg-abyss border-t border-x border-line p-5 shadow-2xl space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-muted">
                  Consultation Transcript Fallback (FR-30)
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleExtractFromTranscript}
                    disabled={isExtracting || transcriptInput.trim().length < 10}
                    className="px-4 py-1.5 rounded bg-success hover:bg-success/85 text-canvas font-bold text-xs disabled:opacity-40"
                    title="Server requires a transcript of at least 10 characters"
                  >
                    {isExtracting ? 'Extracting...' : '✨ Run AI Scribe on Transcript'}
                  </button>
                </div>
              </div>
              <textarea
                rows={4}
                value={transcriptInput}
                onChange={(e) => setTranscriptInput(e.target.value)}
                placeholder="Paste the consultation transcript here as a manual fallback when the microphone is unavailable. The same grounding rules apply: every claim must trace verbatim to this text."
                className="w-full rounded-xl bg-canvas border border-line p-3 text-xs font-mono text-ink placeholder:text-muted focus:outline-none"
              />
            </div>
          )}
        </div>

        {/* Dedicated, capture-hardened New Recording panel (Scribenote style).
            Owns mic capture, consent strip, 2-hour guard, Unsynced ->
            Transcribing statuses, and completes a recording shell via /extract. */}
        <NewRecordingPanel
          open={recordingPanelOpen}
          defaultPetId={defaultPetId}
          staffRole={staffRole}
          staffId={staffId}
          staffName={staffName}
          isExtracting={isExtracting}
          accent="amber"
          contextLabel="Voice note • demo patient Leo"
          onClose={() => setRecordingPanelOpen(false)}
          onCompleted={handlePanelRecorded}
          onFallbackRequested={handlePanelFallback}
          onRecordingStateChange={handlePanelRecordingState}
        />

        {/* Scribenote-parity audio upload panel — same consent strip, MIME
            whitelist, 25 MB guard, and grounded statuses. */}
        <UploadAudioPanel
          open={uploadPanelOpen}
          defaultPetId={defaultPetId}
          staffRole={staffRole}
          staffId={staffId}
          staffName={staffName}
          accent="amber"
          contextLabel="Upload • demo patient Leo"
          onClose={() => setUploadPanelOpen(false)}
          onCompleted={handlePanelRecorded}
        />
      </div>
    </div>
  );
};
