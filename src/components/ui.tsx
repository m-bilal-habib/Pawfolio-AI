"use client";

import { motion, type Variants } from "framer-motion";
import { CheckCircle2, Sparkles, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { Role } from "@/lib/data";

export function PageFade({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: "easeOut" }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

export const staggerParent: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05 } },
};

export const staggerChild: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" } },
};

export function slideIn(side: "left" | "right"): Variants {
  return {
    hidden: { opacity: 0, x: side === "left" ? -48 : 48 },
    show: { opacity: 1, x: 0, transition: { duration: 0.55, ease: "easeOut" } },
  };
}

const statusStyles: Record<string, string> = {
  Draft: "bg-warning/15 text-yellow-300",
  Verified: "bg-success/15 text-green-300",
  Unverified: "bg-warning/10 text-yellow-200",
  Superseded: "bg-white/5 text-muted",
  "Owner Reported": "bg-amber-400/10 text-amber-300",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        statusStyles[status] ?? "bg-white/5 text-muted"
      }`}
    >
      {status === "Verified" && <CheckCircle2 className="h-3.5 w-3.5" />}
      {status}
    </span>
  );
}

const roleStyles: Record<Role, string> = {
  Veterinarian: "bg-primary/15 text-primary-dark",
  Receptionist: "bg-sky-400/10 text-sky-300",
  Assistant: "bg-white/5 text-muted",
  Admin: "bg-white/10 text-ink",
};

export function RoleBadge({ role }: { role: Role }) {
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${roleStyles[role]}`}>
      {role}
    </span>
  );
}

export function OwnerRoleBadge() {
  return (
    <span className="inline-flex rounded-full bg-accent/15 px-2.5 py-0.5 text-xs font-semibold text-accent-dark">
      Owner
    </span>
  );
}

export function AiDraftLabel() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning/15 px-2.5 py-1 text-xs font-semibold text-yellow-300">
      <Sparkles className="h-3.5 w-3.5" />
      AI Draft: Pending Review
    </span>
  );
}

export function OwnerReportedLabel() {
  return (
    <span className="inline-flex items-center rounded-full bg-amber-400/10 px-2.5 py-1 text-xs font-semibold text-amber-300">
      Owner Reported: Unverified
    </span>
  );
}

export function VerifiedLabel() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2.5 py-1 text-xs font-semibold text-green-300">
      <CheckCircle2 className="h-3.5 w-3.5" />
      Verified
    </span>
  );
}

export function StatCard({
  icon: Icon,
  value,
  label,
  tone = "blue",
}: {
  icon: LucideIcon;
  value: string;
  label: string;
  tone?: "blue" | "orange";
}) {
  return (
    <motion.div
      variants={staggerChild}
      className="rounded-xl border border-line bg-surface p-5 shadow-sm shadow-black/20"
    >
      <div className="flex items-center justify-between">
        <span
          className={`flex h-10 w-10 items-center justify-center rounded-lg ${
            tone === "blue" ? "bg-primary/15 text-primary-dark" : "bg-accent/15 text-accent-dark"
          }`}
        >
          <Icon className="h-5 w-5" />
        </span>
        <p className="font-display text-3xl font-extrabold text-ink">{value}</p>
      </div>
      <p className="mt-3 text-sm font-medium text-muted">{label}</p>
    </motion.div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  body,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
}) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed border-line bg-white/[0.03] px-6 py-12 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/15 text-primary-dark">
        <Icon className="h-7 w-7" />
      </span>
      <p className="mt-4 font-display text-lg font-bold text-ink">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-muted">{body}</p>
    </div>
  );
}