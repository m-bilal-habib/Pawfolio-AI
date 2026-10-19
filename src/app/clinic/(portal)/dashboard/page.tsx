"use client";

import { motion } from "framer-motion";
import { CalendarDays, ClipboardList, ListTodo, Sparkles, Users } from "lucide-react";
import Link from "next/link";
import { AIDraftPanel } from "@/components/cards";
import { EmptyState, StatCard, staggerChild, staggerParent } from "@/components/ui";
import { roleDisplayName, useAuth } from "@/lib/auth";
import { aiDrafts, appointments, careTasks, intakeTasks, registrationQueue } from "@/lib/data";

export default function ClinicDashboard() {
  const { clinicRole } = useAuth();
  if (!clinicRole) return null;

  const stats = [
    { icon: CalendarDays, value: String(appointments.length), label: "Today's appointments" },
    { icon: ClipboardList, value: String(aiDrafts.length), label: "Pending orders and drafts" },
    { icon: ListTodo, value: String(careTasks.length), label: "Unresolved tasks" },
    { icon: Users, value: "4", label: "Active patients" },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-3xl font-extrabold text-ink">
          Good morning, {roleDisplayName[clinicRole]}
        </h1>
        <p className="mt-1 text-sm text-muted">Here is what needs your attention today.</p>
      </div>

      <motion.div variants={staggerParent} initial="hidden" animate="show" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((s) => (
          <StatCard key={s.label} icon={s.icon} value={s.value} label={s.label} />
        ))}
      </motion.div>

      <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <motion.section
          variants={staggerParent}
          initial="hidden"
          animate="show"
          className="rounded-2xl border border-line bg-surface p-5 shadow-sm"
        >
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg font-bold text-ink">Appointments</h2>
            <Link href="/clinic/patients" className="text-sm font-semibold text-primary-dark hover:underline">
              All patients
            </Link>
          </div>
          <ul className="mt-4 space-y-3">
            {appointments.map((a) => (
              <motion.li
                key={a.id}
                variants={staggerChild}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-sidebar px-4 py-3"
              >
                <div>
                  <p className="font-semibold text-ink">
                    {a.petName}
                    <span className="ml-2 text-sm font-normal text-muted">with {a.ownerName}</span>
                  </p>
                  <p className="text-sm text-muted">
                    {a.time} · {a.visitType}
                  </p>
                </div>
                <Link
                  href="/clinic/patients/buddy"
                  className="rounded-lg border border-primary px-3.5 py-1.5 text-sm font-semibold text-primary-dark transition-colors hover:bg-primary hover:text-canvas"
                >
                  View Patient
                </Link>
              </motion.li>
            ))}
          </ul>
        </motion.section>

        <div className="space-y-6">
          {(clinicRole === "Veterinarian" || clinicRole === "Admin") && (
            <section className="space-y-4">
              <h2 className="font-display text-lg font-bold text-ink">Pending AI drafts</h2>
              {aiDrafts.map((d) => (
                <div key={d.id}>
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-sm font-semibold text-ink">{d.petName}</p>
                    <span className="text-xs text-muted">{d.source}</span>
                  </div>
                  <AIDraftPanel draft={d} />
                </div>
              ))}
            </section>
          )}

          {clinicRole === "Receptionist" && (
            <section className="rounded-2xl border border-line bg-surface p-5 shadow-sm">
              <h2 className="font-display text-lg font-bold text-ink">Registration queue</h2>
              <ul className="mt-4 space-y-3">
                {registrationQueue.map((r) => (
                  <li key={r.id} className="rounded-xl bg-sidebar px-4 py-3">
                    <p className="font-semibold text-ink">{r.label}</p>
                    <p className="mt-0.5 text-sm text-muted">{r.detail}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {clinicRole === "Assistant" && (
            <section className="rounded-2xl border border-line bg-surface p-5 shadow-sm">
              <h2 className="font-display text-lg font-bold text-ink">Intake tasks</h2>
              <ul className="mt-4 space-y-3">
                {intakeTasks.map((t) => (
                  <li key={t.id} className="rounded-xl bg-sidebar px-4 py-3">
                    <p className="font-semibold text-ink">{t.label}</p>
                    <p className="mt-0.5 text-sm text-muted">{t.detail}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {clinicRole === "Veterinarian" && aiDrafts.length === 0 && (
            <EmptyState icon={Sparkles} title="No drafts waiting" body="New dictation and uploaded reports will appear here for review." />
          )}
        </div>
      </div>
    </div>
  );
}