"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  ChevronDown,
  FileImage,
  FileText,
  Pill,
  RefreshCw,
  Stethoscope,
  Syringe,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import {
  eventTone,
  type CareTask,
  type Doc,
  type Medication,
  type Pet,
  type TimelineEntry,
  type TodayAction,
} from "@/lib/data";
import { AiDraftLabel, StatusBadge } from "./ui";

const typeIcon: Record<TimelineEntry["type"], LucideIcon> = {
  visit: Stethoscope,
  vaccination: Syringe,
  test: FileText,
  medication: Pill,
};

export function PatientCard({ pet }: { pet: Pet }) {
  return (
    <motion.div
      whileHover={{ y: -2 }}
      className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-line bg-surface p-4 shadow-sm shadow-black/20"
    >
      <div className="flex items-center gap-4">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/15 font-display text-lg font-extrabold text-primary-dark">
          {pet.name.charAt(0)}
        </span>
        <div>
          <p className="font-semibold text-ink">
            {pet.name}
            <span className="ml-2 text-sm font-normal text-muted">
              {pet.species}, {pet.breed}
            </span>
          </p>
          <p className="text-sm text-muted">
            {pet.owner} · {pet.weight} · {pet.age}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {pet.badges.includes("Allergies") && (
          <span className="rounded-full bg-error/15 px-2.5 py-0.5 text-xs font-semibold text-red-400">
            Allergies
          </span>
        )}
        <StatusBadge status="Verified" />
        <Link
          href={`/clinic/patients/${pet.id}`}
          className="rounded-lg border border-primary px-3.5 py-1.5 text-sm font-semibold text-primary-dark transition-colors hover:bg-primary hover:text-canvas"
        >
          View Patient
        </Link>
      </div>
    </motion.div>
  );
}

export function TimelineEvent({ event, accent = "blue" }: { event: TimelineEntry; accent?: "blue" | "orange" }) {
  const [open, setOpen] = useState(false);
  const tone = eventTone[event.type];
  const Icon = typeIcon[event.type];

  return (
    <div className="relative flex gap-4 pb-8">
      <div className="flex flex-col items-center">
        <span className={`z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-canvas ${tone.dot}`}>
          <Icon className="h-4 w-4" />
        </span>
        <span className="w-px flex-1 bg-line" />
      </div>
      <motion.div
        layout
        className={`flex-1 rounded-xl border bg-surface p-4 shadow-sm shadow-black/20 ${
          accent === "orange" ? "border-accent/25" : "border-line"
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="rounded-md bg-white/5 px-2 py-1 text-xs font-semibold text-muted">{event.date}</span>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${tone.chip}`}>{tone.label}</span>
        </div>
        <p className="mt-2 font-semibold text-ink">{event.title}</p>
        <p className="text-sm text-muted">
          {event.clinic} · {event.vet}
        </p>
        <p className="mt-1 text-sm leading-relaxed text-muted">{event.summary}</p>
        {event.careCard && (
          <>
            <button
              onClick={() => setOpen((v) => !v)}
              className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-primary-dark"
            >
              View Details
              <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
            </button>
            <AnimatePresence initial={false}>
              {open && (
                <motion.div
                  key="care"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.3, ease: "easeInOut" }}
                  className="overflow-hidden"
                >
                  <p className="mt-2 rounded-lg bg-white/5 p-3 text-sm leading-relaxed text-ink">
                    {event.careCard}
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}
      </motion.div>
    </div>
  );
}

export function DoseCard({ action }: { action: TodayAction }) {
  const [logged, setLogged] = useState(action.logged);

  return (
    <motion.div
      layout
      className={`rounded-xl border bg-surface p-4 shadow-sm shadow-black/20 ${
        logged ? "border-line opacity-80" : "border-accent/30"
      }`}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="font-semibold text-ink">{action.medicine}</p>
          <p className="text-sm text-muted">
            {action.dose} · due {action.due}
          </p>
        </div>
        {logged && (
          <motion.span
            initial={{ scale: 0.9 }}
            animate={{ scale: [0.95, 1.05, 1] }}
            transition={{ duration: 0.35 }}
            className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm font-semibold ${
              logged.status === "Given" ? "bg-success/15 text-green-300" : "bg-error/15 text-red-400"
            }`}
          >
            {logged.status === "Given" ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
            {logged.status} at {logged.at}
          </motion.span>
        )}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <motion.button
          whileTap={{ scale: 0.95 }}
          disabled={Boolean(logged)}
          onClick={() => setLogged({ status: "Given", at: "now" })}
          className="flex items-center justify-center gap-2 rounded-xl bg-success py-3 text-sm font-bold text-white transition-colors hover:bg-green-600 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-muted"
        >
          <Check className="h-5 w-5" />
          Given
        </motion.button>
        <motion.button
          whileTap={{ scale: 0.95 }}
          disabled={Boolean(logged)}
          onClick={() => setLogged({ status: "Skipped", at: "now" })}
          className="flex items-center justify-center gap-2 rounded-xl border-2 border-error py-3 text-sm font-bold text-red-400 transition-colors hover:bg-error hover:text-white disabled:cursor-not-allowed disabled:border-white/10 disabled:text-muted"
        >
          <X className="h-5 w-5" />
          Skipped
        </motion.button>
      </div>
    </motion.div>
  );
}

export function MedCard({ med }: { med: Medication }) {
  const [requested, setRequested] = useState(false);
  const done = med.daysTotal - med.daysLeft;
  const pct = Math.round((done / med.daysTotal) * 100);

  return (
    <motion.div layout className="rounded-xl border border-line bg-surface p-5 shadow-sm shadow-black/20">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-display text-lg font-bold text-ink">{med.name}</p>
          <p className="text-sm text-muted">
            {med.dose} · {med.route} · {med.frequency}
          </p>
        </div>
        <span className="rounded-full bg-accent/15 px-3 py-1 text-xs font-semibold text-accent-dark">
          {med.daysLeft} days left
        </span>
      </div>

      <div className="mt-4">
        <div className="flex justify-between text-xs font-medium text-muted">
          <span>Course progress</span>
          <span>{pct}%</span>
        </div>
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-white/10">
          <motion.div
            initial={{ width: 0 }}
            whileInView={{ width: `${pct}%` }}
            viewport={{ once: true }}
            transition={{ duration: 0.8, ease: "easeOut" }}
            className="h-full rounded-full bg-accent"
          />
        </div>
      </div>

      <div className="mt-4">
        <p className="text-xs font-medium text-muted">Last 7 days</p>
        <div className="mt-1.5 flex gap-2">
          {med.week.map((day, i) => (
            <span
              key={i}
              title={day}
              className={`h-6 w-6 rounded-full ${
                day === "given" ? "bg-success" : day === "skipped" ? "bg-error" : "bg-white/15"
              }`}
            />
          ))}
        </div>
      </div>

      <div className="mt-4 flex justify-end">
        <motion.button
          whileTap={{ scale: 0.95 }}
          disabled={requested}
          onClick={() => setRequested(true)}
          className="inline-flex items-center gap-2 rounded-lg border border-accent px-4 py-2 text-sm font-semibold text-accent-dark transition-colors hover:bg-accent hover:text-canvas disabled:cursor-not-allowed disabled:border-white/10 disabled:text-muted"
        >
          <RefreshCw className="h-4 w-4" />
          {requested ? "Refill requested" : "Request Refill"}
        </motion.button>
      </div>
    </motion.div>
  );
}

export function DocumentCard({ doc }: { doc: Doc }) {
  const Icon = doc.kind === "PDF" ? FileText : FileImage;
  return (
    <motion.div
      whileHover={{ y: -3 }}
      className={`rounded-xl border bg-surface p-4 shadow-sm shadow-black/20 ${
        doc.status === "Unverified" ? "border-warning/50" : "border-line"
      }`}
    >
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/5 text-muted">
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="truncate font-semibold text-ink">{doc.name}</p>
          <p className="text-xs text-muted">
            {doc.kind} · {doc.date}
          </p>
        </div>
      </div>
      <div className="mt-3">
        <StatusBadge status={doc.status} />
      </div>
    </motion.div>
  );
}

const priorityStyles: Record<CareTask["priority"], string> = {
  High: "bg-error/15 text-red-400",
  Medium: "bg-warning/15 text-yellow-300",
  Low: "bg-white/5 text-muted",
};

export function CareTaskCard({ task, onResolve }: { task: CareTask; onResolve: (id: string) => void }) {
  return (
    <motion.div
      layout
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.25 }}
      className="rounded-xl border border-line bg-surface p-4 shadow-sm shadow-black/20"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-muted">{task.kind}</span>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${priorityStyles[task.priority]}`}>
          {task.priority}
        </span>
      </div>
      <p className="mt-2 font-semibold text-ink">{task.petName}</p>
      <p className="mt-1 text-sm leading-relaxed text-muted">{task.detail}</p>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-muted">{task.at}</span>
        <motion.button
          whileTap={{ scale: 0.95 }}
          onClick={() => onResolve(task.id)}
          className="rounded-lg bg-primary px-4 py-1.5 text-sm font-semibold text-canvas transition-colors hover:bg-primary-dark"
        >
          Resolve
        </motion.button>
      </div>
    </motion.div>
  );
}

export function AIDraftPanel({
  draft,
  onConfirm,
}: {
  draft: { fields: { label: string; value: string; ok: boolean }[]; missing: string[] };
  onConfirm?: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);

  return (
    <div className="rounded-xl border border-warning/40 bg-warning/[0.06] p-4">
      <AiDraftLabel />
      <ul className="mt-3 space-y-2">
        {draft.fields.map((f) => (
          <li key={f.label} className="flex items-start justify-between gap-3 text-sm">
            <span className="text-muted">{f.label}</span>
            <span className="flex items-center gap-1.5 font-medium text-ink">
              {f.ok ? (
                <Check className="h-4 w-4 text-success" />
              ) : (
                <X className="h-4 w-4 text-error" />
              )}
              {f.value}
            </span>
          </li>
        ))}
      </ul>
      {draft.missing.length > 0 && (
        <p className="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-xs font-semibold text-yellow-300">
          Missing: {draft.missing.join(", ")}. Flagged, never guessed.
        </p>
      )}
      <motion.button
        whileTap={{ scale: 0.96 }}
        disabled={confirmed}
        onClick={() => {
          setConfirmed(true);
          onConfirm?.();
        }}
        className="mt-4 w-full rounded-lg bg-primary py-2.5 text-sm font-bold text-canvas transition-colors hover:bg-primary-dark disabled:cursor-not-allowed disabled:bg-success/30 disabled:text-green-300"
      >
        {confirmed ? "Confirmed by veterinarian" : "Review and confirm"}
      </motion.button>
    </div>
  );
}