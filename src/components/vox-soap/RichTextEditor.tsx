// File: d:\Pawfolio AI\src\components\vox-soap\RichTextEditor.tsx
'use client';

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { richTextToPlainText } from '@/lib/vox-soap/vox-soap.richtext';

/**
 * Scribenote-parity SOAP section editor with a REAL-TIME Writing Assistant.
 *
 * The ✨ button converts the section INSTANTLY in one click:
 *  • Bullet Point / Paragraph Form are pure structural transforms — applied
 *    locally in the same frame (no network, no waiting).
 *  • Terminology / Abbreviations / Language / Subheadings need wording
 *    changes — one click fires the AI and applies the rewritten text
 *    DIRECTLY (no confirm step), with an inline ✂ Undo bar as the safety
 *    hatch.
 * Settings live behind the ▾ caret (combinable, Scribenote docs parity):
 *   Format (Bullet Point / Paragraph Form / Add Subheadings),
 *   Terminology (Medical / Laymans), Abbreviations (Medical Abbreviations /
 *   Full Words), Language (EN / FR / ES / PT / DE). "Preview diff first"
 *   keeps the accept/reject review for the cautious path.
 * The floating selection bubble (✨ above highlighted text) converts just
 * the selection instantly.
 * The AI rewrite rides /api/clinic/vox-soap/assistant (serialized quota-safe
 * Gemini channel). It can restyle text only — the server prompt forbids new
 * clinical facts.
 */

export type WritingAssistantSection = 'subjective' | 'objective' | 'assessment' | 'plan';

export interface WritingAssistantSelection {
  format: 'bullet' | 'paragraph' | 'subheadings' | null;
  terminology: 'medical' | 'laymans' | null;
  abbreviations: 'abbreviated' | 'full' | null;
  language: 'English' | 'French' | 'Spanish' | 'Portuguese' | 'German' | null;
}

interface DiffOp {
  text: string;
  op: 'same' | 'add' | 'del';
}

interface AppliedBar {
  scope: 'section' | 'selection';
  model: string;
  prevHtml: string;
  summary: string;
}

const NEUTRAL_OPTIONS: WritingAssistantSelection = {
  format: null,
  terminology: null,
  abbreviations: null,
  language: 'English',
};

/** Display names for the currently-selected option shown on each group row. */
const FORMAT_LABELS: Record<string, string> = {
  bullet: 'Bullet Point',
  paragraph: 'Paragraph Form',
  subheadings: 'Add Subheadings',
};
const TERMINOLOGY_LABELS: Record<string, string> = {
  medical: 'Medical',
  laymans: 'Laymans',
};
const ABBREV_LABELS: Record<string, string> = {
  abbreviated: 'Medical Abbreviations',
  full: 'Full Words',
};

const MAX_DIFF_CHARS = 6_000;

/** LCS word-level diff (whitespace-aware tokens; bounded for POHS safety). */
function diffWords(original: string, revised: string): DiffOp[] {
  const a =
    original.length > MAX_DIFF_CHARS ? original.slice(0, MAX_DIFF_CHARS) : original;
  const b = revised.length > MAX_DIFF_CHARS ? revised.slice(0, MAX_DIFF_CHARS) : revised;
  const A = tokenize(a);
  const B = tokenize(b);
  const n = Math.min(A.length, 1_200);
  const m = Math.min(B.length, 1_200);
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        A[i] === B[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      ops.push({ text: B[j], op: 'same' });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ text: A[i], op: 'del' });
      i++;
    } else {
      ops.push({ text: B[j], op: 'add' });
      j++;
    }
  }
  while (i < n) ops.push({ text: A[i++], op: 'del' });
  while (j < m) ops.push({ text: B[j++], op: 'add' });
  return ops;

  function tokenize(t: string): string[] {
    return t.split(/(\s+)/).filter((x) => x !== '');
  }
}

/** Maps assistant plain-text output to sanitized rich paragraphs/bullets. */
function buildRichFromAssistantText(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const lines = escaped.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const out: string[] = [];
  let bulletRun: string[] = [];
  const flushBullets = () => {
    if (bulletRun.length) {
      out.push(`<ul>${bulletRun.map((l) => `<li>${l}</li>`).join('')}</ul>`);
      bulletRun = [];
    }
  };
  for (const line of lines) {
    const bulletMatch = line.match(/^(?:[-•*]|(?:\d+)[.)])\s+(.*)$/);
    if (bulletMatch) {
      bulletRun.push(bulletMatch[1]);
      continue;
    }
    flushBullets();
    const isSubheading =
      line.length <= 46 && /^[^a-z]*$/.test(line.replace(/[^A-Za-z]/g, '')) && /[A-Z]/.test(line);
    if (isSubheading) {
      out.push(`<h3>${line.replace(/:$/, '')}</h3>`);
    } else {
      out.push(`<p>${line}</p>`);
    }
  }
  flushBullets();
  return out.join('');
}

/** Deterministic OFFLINE format transforms (realtime, zero network). */
function localFormatTransform(text: string, format: 'bullet' | 'paragraph'): string | null {
  const escape = (t: string) =>
    t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const stripMarkers = (l: string) => l.replace(/^[-•*\d.)\s]*\s*/, '');

  if (format === 'bullet') {
    let lines = text
      .split(/\r?\n/)
      .map((l) => stripMarkers(l.trim()))
      .filter(Boolean);
    // One long prose block → split into sentence bullets; fall back to the
    // field separator the note text itself uses ("·").
    if (lines.length === 1 && lines[0].length > 140) {
      let parts = (lines[0].match(/[^.!?;]+[.!?;]*/g) ?? [lines[0]])
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length <= 1) {
        parts = lines[0]
          .split(/\s+·\s+/)
          .map((s) => s.trim())
          .filter(Boolean);
      }
      lines = parts;
    }
    if (lines.length === 0) return null;
    return `<ul>${lines.map((l) => `<li>${escape(l)}</li>`).join('')}</ul>`;
  }

  // paragraph: merge everything into flowing prose.
  const merged = text
    .replace(/\r?\n+/g, ' ')
    .replace(/(?:^|\s)[-•*]\s+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!merged) return null;
  return `<p>${escape(merged)}</p>`;
}

function isNeutralOptions(o: WritingAssistantSelection): boolean {
  return (
    !o.format &&
    !o.terminology &&
    !o.abbreviations &&
    (!o.language || o.language === 'English')
  );
}

function optionsSummary(o: WritingAssistantSelection): string {
  const parts: string[] = [];
  if (o.format === 'bullet') parts.push('Bullet Point');
  if (o.format === 'paragraph') parts.push('Paragraph Form');
  if (o.format === 'subheadings') parts.push('Subheadings');
  if (o.terminology === 'medical') parts.push('Medical terms');
  if (o.terminology === 'laymans') parts.push('Laymans');
  if (o.abbreviations === 'abbreviated') parts.push('Vet abbreviations');
  if (o.abbreviations === 'full') parts.push('Full words');
  if (o.language && o.language !== 'English') parts.push(o.language);
  return parts.join(' · ') || 'no changes selected';
}

export function RichTextEditor(props: {
  sectionKey: WritingAssistantSection;
  sectionLabel: string;
  initialHtml: string;
  readOnly?: boolean;
  placeholder?: string;
  visitId?: string | null;
  staffHeaders: { role: string; id: string; name: string };
  onHtmlChange?: (html: string) => void;
  minHeight?: number;
}) {
  const {
    sectionLabel,
    initialHtml,
    readOnly = false,
    placeholder = 'Type or edit the section text…',
    visitId,
    staffHeaders,
    onHtmlChange,
    minHeight = 96,
  } = props;

  const editorRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const savedRangeRef = useRef<Range | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const caretRef = useRef<HTMLButtonElement | null>(null);

  const [bubble, setBubble] = useState<{ visible: boolean; top: number; left: number }>({
    visible: false,
    top: 0,
    left: 0,
  });
  const [menuOpen, setMenuOpen] = useState<boolean>(false);
  const [menuPlacement, setMenuPlacement] = useState<'down' | 'up'>('down');
  const [menuCoords, setMenuCoords] = useState<{ top: number; bottom: number | null; left: number }>({
    top: 0,
    bottom: null,
    left: 0,
  });
  const [openSubMenu, setOpenSubMenu] = useState<string | null>(null);
  const [options, setOptions] = useState<WritingAssistantSelection>(NEUTRAL_OPTIONS);
  const [appliedBar, setAppliedBar] = useState<AppliedBar | null>(null);
  const [assistant, setAssistant] = useState<{
    phase: 'running' | 'review' | null;
    original: string;
    revised: string;
    scope: 'section' | 'selection';
    model: string | null;
    error: string | null;
  }>({ phase: null, original: '', revised: '', scope: 'section', model: null, error: null });
  const [copiedFlash, setCopiedFlash] = useState<boolean>(false);

  const isAssistantBusy = assistant.phase === 'running';
  const optionsNeutral = isNeutralOptions(options);

  // (Re)initialize editor content when the parent hands over fresh HTML.
  useEffect(() => {
    if (editorRef.current && editorRef.current.innerHTML !== initialHtml) {
      editorRef.current.innerHTML = initialHtml;
    }
  }, [initialHtml]);

  // Selection bubble: show ✨ + quick marks above the selection.
  useEffect(() => {
    if (readOnly) return;
    const onSelectionChange = () => {
      const sel = window.getSelection();
      const editor = editorRef.current;
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !editor) {
        setBubble((prev) => (prev.visible ? { ...prev, visible: false } : prev));
        return;
      }
      const node = sel.anchorNode;
      if (!node || !editor.contains(node)) {
        setBubble((prev) => (prev.visible ? { ...prev, visible: false } : prev));
        return;
      }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const wrapperRect = wrapperRef.current?.getBoundingClientRect();
      if (!wrapperRect || rect.width === 0) return;
      savedRangeRef.current = range.cloneRange();
      setBubble({
        visible: true,
        top: rect.top - wrapperRect.top - 46,
        left: Math.max(
          8,
          Math.min(rect.left - wrapperRect.left, (wrapperRect.width ?? 400) - 150)
        ),
      });
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [readOnly]);

  /**
   * Position the settings menu with fixed coordinates relative to the caret.
   * The panel is portaled into document.body (fixed coordinates, top stacking).
   * or stack it. 'up' anchors the panel bottom just above the caret; 'down'
   * anchors its top just below. The left edge is clamped to the viewport so
   * narrow screens never push it out of view.
   */
  const placeMenu = useCallback(() => {
    const caretEl = caretRef.current;
    if (!caretEl) return;
    const rect = caretEl.getBoundingClientRect();
    const gutter = 8;
    const menuWidth = 240; // w-60
    const left = Math.min(
      Math.max(gutter, rect.right - menuWidth),
      Math.max(gutter, window.innerWidth - gutter - menuWidth)
    );
    const below = window.innerHeight - rect.bottom;
    const above = rect.top;
    if (above > below && below < 340) {
      setMenuCoords({ top: 0, bottom: window.innerHeight - rect.top + 6, left });
      setMenuPlacement('up');
    } else {
      setMenuCoords({ top: rect.bottom + 6, bottom: null, left });
      setMenuPlacement('down');
    }
  }, []);

  // Settings menu dismissal: outside clicks and Escape. The caret toggles
  // itself, and clicks inside the panel never dismiss.
  useEffect(() => {
    if (!menuOpen || readOnly) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (menuRef.current && menuRef.current.contains(target)) return;
      if (caretRef.current && caretRef.current.contains(target)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    // Any scroll (window or inner containers) while open repositions the
    // fixed panel so it stays welded to the caret. Ignore scrolls that
    // originate inside the panel itself.
    const onScroll = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      placeMenu();
    };
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', placeMenu);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', placeMenu);
    };
  }, [menuOpen, readOnly, placeMenu]);

  // Self-correcting placement: once rendered, if the panel overflows the
  // viewport on the chosen side and the other side fits, flip it before paint.
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const panel = menuRef.current;
    const caretEl = caretRef.current;
    if (!panel || !caretEl) return;
    const rect = panel.getBoundingClientRect();
    const cRect = caretEl.getBoundingClientRect();
    const margin = 8;
    if (menuPlacement === 'down' && rect.bottom > window.innerHeight - margin) {
      if (rect.height <= cRect.top - margin) setMenuPlacement('up');
    } else if (menuPlacement === 'up' && rect.top < margin) {
      if (rect.height <= window.innerHeight - cRect.bottom - margin) setMenuPlacement('down');
    }
  }, [menuOpen, menuPlacement, openSubMenu, options]);

  const exec = useCallback(
    (command: string, value?: string) => {
      editorRef.current?.focus();
      document.execCommand(command, false, value);
      if (editorRef.current && onHtmlChange) {
        onHtmlChange(editorRef.current.innerHTML);
      }
    },
    [onHtmlChange]
  );

  const handleInput = useCallback(() => {
    if (editorRef.current && onHtmlChange) {
      onHtmlChange(editorRef.current.innerHTML);
    }
  }, [onHtmlChange]);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      if (readOnly) return;
      e.preventDefault();
      const text = e.clipboardData.getData('text/plain');
      document.execCommand('insertText', false, text);
    },
    [readOnly]
  );

  const commitEditor = useCallback(
    (newHtml: string) => {
      if (editorRef.current) {
        editorRef.current.innerHTML = newHtml;
      }
      if (onHtmlChange) onHtmlChange(newHtml);
    },
    [onHtmlChange]
  );

  /** Realtime apply with one-step Undo. Returns nothing; paints immediately. */
  const applyInstant = useCallback(
    (newHtml: string, scope: 'section' | 'selection', model: string) => {
      const editor = editorRef.current;
      if (!editor) return;
      const prevHtml = editor.innerHTML;
      if (scope === 'section') {
        commitEditor(newHtml);
      } else {
        editor.focus();
        const saved = savedRangeRef.current;
        replacedSelection(editor, saved, newHtml);
        if (onHtmlChange) onHtmlChange(editor.innerHTML);
      }
      setAssistant({ phase: null, original: '', revised: '', scope: 'section', model: null, error: null });
      setMenuOpen(false);
      setBubble((prev) => ({ ...prev, visible: false }));
      setAppliedBar({ scope, model, prevHtml, summary: optionsSummary(options) });
    },
    [commitEditor, onHtmlChange, options]
  );

  /** Replaces the saved selection range with rich HTML (fallbacks included). */
  function replacedSelection(_editor: HTMLElement, saved: Range | null, richHtml: string) {
    const sel = window.getSelection();
    let ok = false;
    if (saved) {
      try {
        sel?.removeAllRanges();
        sel?.addRange(saved);
        ok = document.execCommand('insertHTML', false, richHtml);
        if (!ok) {
          ok = document.execCommand('insertText', false, richTextToPlainText(richHtml));
        }
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      document.execCommand('insertParagraph', false);
      document.execCommand('insertHTML', false, richHtml);
    }
  }

  /** ONE-CLICK realtime conversion used by the toolbar + bubble buttons. */
  const convertNow = useCallback(
    async (scope: 'section' | 'selection') => {
      const editor = editorRef.current;
      if (!editor || isAssistantBusy) return;
      let text =
        scope === 'selection'
          ? window.getSelection()?.toString() || savedRangeRef.current?.toString() || ''
          : editor.innerText || '';
      if (scope === 'selection' && !text.trim()) {
        scope = 'section';
        text = editor.innerText || '';
      }
      if (!text.trim()) {
        setAssistant({
          phase: null,
          original: '',
          revised: '',
          scope: 'section',
          model: null,
          error: 'This section is empty — write something to convert.',
        });
        return;
      }
      if (optionsNeutral) {
        setAssistant({
          phase: null,
          original: '',
          revised: '',
          scope: 'section',
          model: null,
          error:
            'Pick at least one Writing Assistant setting from the ▾ menu (Bullet Point, Laymans, French…).',
        });
        return;
      }

      // 1) Realtime OFFLINE conversion (same frame, zero network).
      const localOnly =
        !options.terminology &&
        !options.abbreviations &&
        (!options.language || options.language === 'English') &&
        (options.format === 'bullet' || options.format === 'paragraph');
      if (localOnly && (options.format === 'bullet' || options.format === 'paragraph')) {
        const html = localFormatTransform(text, options.format);
        if (html) {
          applyInstant(html, scope, 'instant offline');
          return;
        }
      }

      // 2) AI conversion (terminology / abbreviations / language / subheadings)
      //    — applies DIRECTLY on response; Undo bar is the safety hatch.
      setAssistant({
        phase: 'running',
        original: text,
        revised: '',
        scope,
        model: null,
        error: null,
      });
      setMenuOpen(false);
      setBubble((prev) => ({ ...prev, visible: false }));
      try {
        const res = await fetch('/api/clinic/vox-soap/assistant', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-staff-role': staffHeaders.role,
            'x-staff-id': staffHeaders.id,
            'x-staff-name': staffHeaders.name,
            'x-clinic-id': 'clinic-lhr-01',
          },
          body: JSON.stringify({
            text,
            sectionLabel,
            options,
            visitId: visitId ?? undefined,
          }),
        });
        const payload = await res.json();
        if (!res.ok) {
          setAssistant((prev) => ({
            ...prev,
            phase: null,
            error: payload.error ?? `Writing Assistant unavailable (HTTP ${res.status}).`,
          }));
          return;
        }
        setAssistant({
          phase: null,
          original: '',
          revised: '',
          scope: 'section',
          model: null,
          error: null,
        });
        applyInstant(
          buildRichFromAssistantText(String(payload.result ?? '')),
          scope,
          String(payload.assistantModel ?? 'Gemini')
        );
      } catch (err) {
        setAssistant((prev) => ({
          ...prev,
          phase: null,
          error: err instanceof Error ? err.message : 'Writing Assistant request failed.',
        }));
      }
    },
    [applyInstant, isAssistantBusy, options, optionsNeutral, sectionLabel, staffHeaders, visitId]
  );

  /** Review-cautious path (menu): preview the diff before applying. */
  const runReview = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor || isAssistantBusy) return;
    const text = editor.innerText || '';
    if (!text.trim()) {
      setAssistant({
        phase: null,
        original: '',
        revised: '',
        scope: 'section',
        model: null,
        error: 'This section is empty — write something first.',
      });
      return;
    }
    if (optionsNeutral) {
      setAssistant({
        phase: null,
        original: '',
        revised: '',
        scope: 'section',
        model: null,
        error:
          'Pick at least one Writing Assistant setting from the menu first.',
      });
      return;
    }
    setAssistant({ phase: 'running', original: text, revised: '', scope: 'section', model: null, error: null });
    setMenuOpen(false);
    setBubble((prev) => ({ ...prev, visible: false }));
    try {
      const res = await fetch('/api/clinic/vox-soap/assistant', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-staff-role': staffHeaders.role,
          'x-staff-id': staffHeaders.id,
          'x-staff-name': staffHeaders.name,
          'x-clinic-id': 'clinic-lhr-01',
        },
        body: JSON.stringify({
          text,
          sectionLabel,
          options,
          visitId: visitId ?? undefined,
        }),
      });
      const payload = await res.json();
      if (!res.ok) {
        setAssistant((prev) => ({
          ...prev,
          phase: null,
          error: payload.error ?? `Writing Assistant unavailable (HTTP ${res.status}).`,
        }));
        return;
      }
      setAssistant({
        phase: 'review',
        original: text,
        revised: String(payload.result ?? ''),
        scope: 'section',
        model: String(payload.assistantModel ?? ''),
        error: null,
      });
    } catch (err) {
      setAssistant((prev) => ({
        ...prev,
        phase: null,
        error: err instanceof Error ? err.message : 'Writing Assistant request failed.',
      }));
    }
  }, [isAssistantBusy, options, optionsNeutral, sectionLabel, staffHeaders, visitId]);

  const acceptRevised = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || !assistant.revised) return;
    const prevHtml = editor.innerHTML;
    commitEditor(buildRichFromAssistantText(assistant.revised));
    setAppliedBar({
      scope: 'section',
      model: assistant.model || 'Gemini',
      prevHtml,
      summary: optionsSummary(options),
    });
    setAssistant({ phase: null, original: '', revised: '', scope: 'section', model: null, error: null });
  }, [assistant.model, assistant.revised, commitEditor, options]);

  const rejectRevised = useCallback(() => {
    setAssistant({ phase: null, original: '', revised: '', scope: 'section', model: null, error: null });
  }, []);

  const undoApplied = useCallback(() => {
    if (!appliedBar) return;
    commitEditor(appliedBar.prevHtml);
    setAppliedBar(null);
  }, [appliedBar, commitEditor]);

  const copySection = useCallback(() => {
    const text = editorRef.current?.innerText ?? '';
    if (navigator.clipboard) void navigator.clipboard.writeText(text);
    setCopiedFlash(true);
    setTimeout(() => setCopiedFlash(false), 1400);
  }, []);

  const renderOptionsMenu = () => {
    const OptionRow: React.FC<{ label: string; active: boolean; onClick: () => void }> = ({
      label,
      active,
      onClick,
    }) => (
      <button
        type="button"
        role="menuitem"
        onClick={onClick}
        className={`w-full flex items-center gap-2 text-left px-2.5 py-1.5 text-[11px] font-semibold rounded-md transition ${
          active ? 'bg-primary/25 text-primary-dark' : 'text-ink hover:bg-canvas'
        }`}
      >
        <span className="w-3.5 shrink-0">{active ? '✓' : ''}</span>
        <span className="truncate">{label}</span>
      </button>
    );
    const GroupRow: React.FC<{ icon: string; label: string; value: string | null; group: string }> = ({
      icon,
      label,
      value,
      group,
    }) => (
      <button
        type="button"
        onClick={() => setOpenSubMenu((p) => (p === group ? null : group))}
        aria-expanded={openSubMenu === group}
        className="w-full flex items-center justify-between gap-2 px-2.5 py-2 text-[11px] font-bold text-ink rounded-md hover:bg-canvas transition"
      >
        <span className="flex items-center gap-1.5 min-w-0">
          <span aria-hidden>{icon}</span>
          <span>{label}</span>
          {value && (
            <span className="text-[10px] font-semibold text-accent truncate max-w-[7rem]">
              · {value}
            </span>
          )}
        </span>
        <span
          className={`text-[10px] text-muted transition-transform ${
            openSubMenu === group ? 'rotate-90' : ''
          }`}
        >
          ▸
        </span>
      </button>
    );
    return (
      <div
        ref={menuRef}
        role="menu"
        aria-label="Writing Assistant settings"
        onMouseDown={(e) => e.preventDefault()}
        className="fixed z-50 w-60 max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface shadow-2xl shadow-black/40 overflow-hidden"
        style={
          menuCoords.bottom === null
            ? { top: menuCoords.top, left: menuCoords.left }
            : { bottom: menuCoords.bottom, left: menuCoords.left }
        }
      >
        {/* Scrollable settings body — bounded so it never runs off-screen. */}
        <div className={`overflow-y-auto p-1.5 space-y-0.5 ${
          menuPlacement === 'down' ? 'max-h-[min(22rem,54vh)]' : 'max-h-[min(20rem,48vh)]'
        }`}>
          <GroupRow
            icon="🧾"
            label="Formatting"
            value={options.format ? FORMAT_LABELS[options.format] : null}
            group="format"
          />
          {openSubMenu === 'format' && (
            <div className="pl-3 pb-1 space-y-0.5">
              <OptionRow
                label="Bullet Point"
                active={options.format === 'bullet'}
                onClick={() =>
                  setOptions((p) => ({ ...p, format: p.format === 'bullet' ? null : 'bullet' }))
                }
              />
              <OptionRow
                label="Paragraph Form"
                active={options.format === 'paragraph'}
                onClick={() =>
                  setOptions((p) => ({
                    ...p,
                    format: p.format === 'paragraph' ? null : 'paragraph',
                  }))
                }
              />
              <OptionRow
                label="Add Subheadings"
                active={options.format === 'subheadings'}
                onClick={() =>
                  setOptions((p) => ({
                    ...p,
                    format: p.format === 'subheadings' ? null : 'subheadings',
                  }))
                }
              />
            </div>
          )}
          <GroupRow
            icon="🩺"
            label="Terminology"
            value={options.terminology ? TERMINOLOGY_LABELS[options.terminology] : null}
            group="terminology"
          />
          {openSubMenu === 'terminology' && (
            <div className="pl-3 pb-1 space-y-0.5">
              <OptionRow
                label="Medical"
                active={options.terminology === 'medical'}
                onClick={() =>
                  setOptions((p) => ({
                    ...p,
                    terminology: p.terminology === 'medical' ? null : 'medical',
                  }))
                }
              />
              <OptionRow
                label="Laymans"
                active={options.terminology === 'laymans'}
                onClick={() =>
                  setOptions((p) => ({
                    ...p,
                    terminology: p.terminology === 'laymans' ? null : 'laymans',
                  }))
                }
              />
            </div>
          )}
          <GroupRow
            icon="ℹ️"
            label="Abbreviations"
            value={options.abbreviations ? ABBREV_LABELS[options.abbreviations] : null}
            group="abbreviations"
          />
          {openSubMenu === 'abbreviations' && (
            <div className="pl-3 pb-1 space-y-0.5">
              <OptionRow
                label="Medical Abbreviations"
                active={options.abbreviations === 'abbreviated'}
                onClick={() =>
                  setOptions((p) => ({
                    ...p,
                    abbreviations: p.abbreviations === 'abbreviated' ? null : 'abbreviated',
                  }))
                }
              />
              <OptionRow
                label="Full Words"
                active={options.abbreviations === 'full'}
                onClick={() =>
                  setOptions((p) => ({
                    ...p,
                    abbreviations: p.abbreviations === 'full' ? null : 'full',
                  }))
                }
              />
            </div>
          )}
          <GroupRow
            icon="🌐"
            label="Language"
            value={options.language ?? null}
            group="language"
          />
          {openSubMenu === 'language' && (
            <div className="pl-3 pb-1 space-y-0.5">
              {(['English', 'French', 'Spanish', 'Portuguese', 'German'] as const).map((lang) => (
                <button
                  key={lang}
                  type="button"
                  role="menuitem"
                  onClick={() =>
                    setOptions((p) => ({ ...p, language: p.language === lang ? 'English' : lang }))
                  }
                  className={`w-full flex items-center gap-2 text-left px-2.5 py-1.5 text-[11px] font-semibold rounded-md transition ${
                    options.language === lang
                      ? 'bg-primary/25 text-primary-dark'
                      : 'text-ink hover:bg-canvas'
                  }`}
                >
                  <span className="w-3.5 shrink-0">{options.language === lang ? '✓' : ''}</span>
                  <span>{lang}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {/* Action footer — always visible regardless of how much is expanded. */}
        <div className="border-t border-line bg-surface px-1.5 py-1.5 space-y-1">
          <button
            type="button"
            onClick={() => convertNow('section')}
            disabled={isAssistantBusy}
            className="w-full px-3 py-2 rounded-lg bg-primary hover:bg-primary-dark text-canvas text-[11px] font-bold flex items-center justify-center gap-1.5 transition whitespace-nowrap disabled:opacity-50"
            title="Convert the whole section right now with the selected settings"
          >
            ⚡ Convert now (realtime)
          </button>
          <button
            type="button"
            onClick={runReview}
            disabled={isAssistantBusy}
            className="w-full px-3 py-1.5 rounded-lg bg-sidebar hover:bg-[#33281f] text-ink text-[11px] font-semibold border border-line transition whitespace-nowrap disabled:opacity-50"
            title="Preview the rewrite as a diff before applying (accept ✅ / reject ❌)"
          >
            🔍 Preview diff first
          </button>
          <p className="text-[10px] text-muted px-1 pt-0.5 leading-snug">
            Combinable settings. Bullet Point &amp; Paragraph Form convert instantly offline;
            wording changes use Gemini.
          </p>
        </div>
      </div>
    );
  };

  return (
    <div
      ref={wrapperRef}
      className={`relative rounded-lg border border-line bg-canvas/60 ${isAssistantBusy ? 'vox-assistant-busy' : ''}`}
      aria-busy={isAssistantBusy}
    >
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-1 px-2 py-1.5 border-b border-line bg-sidebar rounded-t-lg">
          <button type="button" onClick={() => exec('bold')} title="Bold (Ctrl+B)" className="w-7 h-7 rounded-md text-xs font-bold text-ink hover:bg-canvas transition">B</button>
          <button type="button" onClick={() => exec('italic')} title="Italic (Ctrl+I)" className="w-7 h-7 rounded-md text-xs italic text-ink hover:bg-canvas transition">I</button>
          <button type="button" onClick={() => exec('underline')} title="Underline (Ctrl+U)" className="w-7 h-7 rounded-md text-xs underline text-ink hover:bg-canvas transition">U</button>
          <button type="button" onClick={() => exec('strikeThrough')} title="Strikethrough" className="w-7 h-7 rounded-md text-xs line-through text-ink hover:bg-canvas transition">S</button>
          <span className="w-px h-5 bg-line mx-1" />
          <button type="button" onClick={() => exec('formatBlock', '<h2>')} title="Heading" className="w-7 h-7 rounded-md text-[10px] font-bold text-ink hover:bg-canvas transition">H</button>
          <button type="button" onClick={() => exec('formatBlock', '<p>')} title="Normal text" className="w-7 h-7 rounded-md text-[10px] text-ink hover:bg-canvas transition">¶</button>
          <span className="w-px h-5 bg-line mx-1" />
          <button type="button" onClick={() => exec('insertUnorderedList')} title="Bullet list" className="w-7 h-7 rounded-md text-[11px] text-ink hover:bg-canvas transition">• ≡</button>
          <button type="button" onClick={() => exec('insertOrderedList')} title="Numbered list" className="w-7 h-7 rounded-md text-[11px] text-ink hover:bg-canvas transition">1. ≡</button>
          <span className="w-px h-5 bg-line mx-1" />
          <button type="button" onClick={() => document.execCommand('undo')} title="Undo (manual edits)" className="w-7 h-7 rounded-md text-xs text-ink hover:bg-canvas transition">↶</button>
          <button type="button" onClick={() => document.execCommand('redo')} title="Redo (manual edits)" className="w-7 h-7 rounded-md text-xs text-ink hover:bg-canvas transition">↷</button>
          <button
            type="button"
            onClick={copySection}
            title="Copy section text"
            className="w-7 h-7 rounded-md text-xs text-ink hover:bg-canvas transition"
          >
            {copiedFlash ? '✓' : '📋'}
          </button>
          <span className="flex-1" />
          {/* Split button: main = one-click realtime conversion; caret = settings.
              The menu anchors to this unclipped wrapper so it is never cut off. */}
          <div className="relative">
            <div className="flex items-stretch rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => convertNow('section')}
                disabled={isAssistantBusy}
                title="Trigger Writing Assistant — converts this section right now with the current settings (instant offline for Bullet Point / Paragraph Form; Gemini for wording changes; ↩ Undo afterwards)"
                className="px-2.5 py-1.5 bg-accent hover:bg-accent-dark text-canvas text-[11px] font-bold flex items-center gap-1.5 transition disabled:opacity-60"
              >
                {isAssistantBusy ? '⏳ Rewriting…' : '✨ Writing Assistant'}
              </button>
              <button
                ref={caretRef}
                type="button"
                onClick={() => {
                  placeMenu();
                  setMenuOpen((p) => !p);
                  setOpenSubMenu(null);
                }}
                disabled={isAssistantBusy}
                aria-label="Writing Assistant settings"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                title="Writing Assistant settings — Bullet Point, Paragraph Form, Subheadings, Terminology, Abbreviations, Language"
                className="px-1.5 bg-accent-dark hover:bg-primary-dark text-canvas text-[10px] font-bold transition border-l border-canvas/20 disabled:opacity-60"
              >
                <span className={`inline-block transition-transform ${menuOpen ? 'rotate-180' : ''}`}>
                  ▾
                </span>
              </button>
            </div>
            {menuOpen && typeof document !== 'undefined'
              ? createPortal(renderOptionsMenu(), document.body)
              : null}
          </div>
        </div>
      )}

      <div
        ref={editorRef}
        contentEditable={!readOnly}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline
        aria-label={`${sectionLabel} section editor`}
        data-placeholder={placeholder}
        onInput={handleInput}
        onPaste={handlePaste}
        onBlur={() => setBubble((prev) => ({ ...prev, visible: false }))}
        className={`vox-rich-editor px-4 py-3 text-sm leading-relaxed text-ink outline-none break-words [&:empty]:before:content-[attr(data-placeholder)] [&:empty]:before:text-muted/70 [&_strong]:font-bold [&_b]:font-bold [&_em]:italic [&_i]:italic [&_u]:underline [&_s]:line-through [&_h2]:font-display [&_h2]:font-extrabold [&_h2]:text-base [&_h2]:mt-1 [&_h3]:font-display [&_h3]:font-bold [&_h3]:text-sm [&_h3]:mt-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 ${
          readOnly ? 'cursor-default' : 'cursor-text'
        }`}
        style={{ minHeight }}
      />

      {/* Floating selection bubble — ✨ converts the selection in one click. */}
      {bubble.visible && !readOnly && !isAssistantBusy && (
        <div
          className="absolute z-30 flex items-center gap-1 rounded-full border border-line bg-surface shadow-xl shadow-black/50 px-1.5 py-1"
          style={{ top: bubble.top, left: bubble.left }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button
            type="button"
            onClick={() => convertNow('selection')}
            title={`Trigger Writing Assistant on the selected text (${optionsSummary(options)})`}
            className="w-7 h-7 rounded-full bg-accent hover:bg-accent-dark text-canvas text-xs font-bold transition"
          >
            ✨
          </button>
          <button type="button" onMouseDown={(e) => { e.preventDefault(); exec('bold'); }} className="w-6 h-6 rounded-full hover:bg-canvas text-[11px] font-bold text-ink transition">B</button>
          <button type="button" onMouseDown={(e) => { e.preventDefault(); exec('italic'); }} className="w-6 h-6 rounded-full hover:bg-canvas text-[11px] italic text-ink transition">I</button>
          <button type="button" onMouseDown={(e) => { e.preventDefault(); exec('underline'); }} className="w-6 h-6 rounded-full hover:bg-canvas text-[11px] underline text-ink transition">U</button>
        </div>
      )}

      {/* Realtime applied bar — instant result + one-step Undo / Keep. */}
      {appliedBar && !assistant.phase && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-accent/40 bg-accent/10 px-3 py-2 text-xs shadow-md">
          <span className="text-ink font-semibold">
            ✨ {appliedBar.scope === 'selection' ? 'Selection' : 'Section'} converted —{' '}
            {appliedBar.model === 'instant offline'
              ? 'instant offline transform'
              : `AI rewrite via ${appliedBar.model}`}{' '}
            <span className="text-muted font-medium">({appliedBar.summary})</span>
          </span>
          <span className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={undoApplied}
              className="px-2.5 py-1 rounded-lg bg-surface hover:bg-[#33281f] text-warning text-[11px] font-bold border border-line transition"
            >
              ↩ Undo
            </button>
            <button
              type="button"
              onClick={() => setAppliedBar(null)}
              className="px-2.5 py-1 rounded-lg bg-success hover:bg-success/85 text-canvas text-[11px] font-bold transition"
            >
              Keep ✓
            </button>
          </span>
        </div>
      )}

      {/* Review-cautious path + inline error/hints (from the ▾ menu). */}
      {(assistant.phase || assistant.error) && (
        <div className="mt-2 rounded-xl border border-accent/40 bg-surface p-3 space-y-2 shadow-lg">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-bold text-ink">
              {assistant.phase === 'running' ? '✨ Writing Assistant is rewriting…' : '✨ Review the rewrite'}
              {assistant.model && assistant.phase === 'review' && (
                <span className="ml-2 font-mono text-[10px] text-muted">via {assistant.model}</span>
              )}
            </span>
            {assistant.phase === 'running' && (
              <span className="text-[10px] text-muted">Quota-safe model chain in progress — applying automatically.</span>
            )}
          </div>

          {assistant.error && (
            <div className="text-xs text-error bg-error/10 border border-error/40 rounded-lg px-3 py-2">
              {assistant.error}{' '}
              <button type="button" onClick={rejectRevised} className="underline">
                Dismiss
              </button>
            </div>
          )}

          {assistant.phase === 'review' && !assistant.error && (
            <>
              <div className="grid gap-2 md:grid-cols-2">
                <div className="rounded-lg border border-success/40 bg-success/5 p-2.5 max-h-56 overflow-auto">
                  <div className="text-[10px] font-bold text-success mb-1">REVISED — accept?</div>
                  <div className="text-xs leading-relaxed whitespace-pre-wrap text-ink">
                    {diffWords(assistant.original, assistant.revised)
                      .filter((d) => d.op !== 'del')
                      .map((d, i) =>
                        d.op === 'add' ? (
                          <span key={i} className="bg-success/25 text-ink rounded-sm">
                            {d.text}
                          </span>
                        ) : (
                          <span key={i}>{d.text}</span>
                        )
                      )}
                  </div>
                </div>
                <div className="rounded-lg border border-error/40 bg-error/5 p-2.5 max-h-56 overflow-auto">
                  <div className="text-[10px] font-bold text-error mb-1">ORIGINAL — kept if you reject</div>
                  <div className="text-xs leading-relaxed whitespace-pre-wrap text-muted">
                    {diffWords(assistant.original, assistant.revised)
                      .filter((d) => d.op !== 'add')
                      .map((d, i) =>
                        d.op === 'del' ? (
                          <span key={i} className="bg-error/25 text-ink line-through rounded-sm">
                            {d.text}
                          </span>
                        ) : (
                          <span key={i}>{d.text}</span>
                        )
                      )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={acceptRevised}
                  className="px-3 py-1.5 rounded-lg bg-success hover:bg-success/85 text-canvas text-xs font-bold transition"
                >
                  ✅ Accept changes
                </button>
                <button
                  type="button"
                  onClick={rejectRevised}
                  className="px-3 py-1.5 rounded-lg bg-sidebar hover:bg-[#33281f] text-warning text-xs font-bold border border-line transition"
                >
                  ❌ Reject
                </button>
                <button
                  type="button"
                  onClick={runReview}
                  className="px-3 py-1.5 rounded-lg bg-sidebar hover:bg-[#33281f] text-ink text-xs font-bold border border-line transition"
                >
                  ↻ Re-run
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
