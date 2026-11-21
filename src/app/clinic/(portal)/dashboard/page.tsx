"use client";

import { motion } from "framer-motion";
import { ArrowRight, CalendarDays, ClipboardList, ListTodo, Mic, Sparkles, Upload, Users } from "lucide-react";
import Link from "next/link";
import { AIDraftPanel } from "@/components/cards";
import { DashboardRecordButton } from "@/components/vox-soap/DashboardRecordButton";
import { EmptyState, StatCard, staggerChild, staggerParent } from "@/components/ui";
import { roleDisplayName, useAuth } from "@/lib/auth";
import { aiDrafts, appointments, careTasks, intakeTasks, pets, registrationQueue } from "@/lib/data";

function petIdForName(petName: string): string {
  return pets.find((p) => p.name.toLowerCase() === petName.toLowerCase())?.id ?? "buddy";
}

export default function ClinicDashboard() {
  const { clinicRole } = useAuth();
  if (!clinicRole) return null;

  const canDictate = clinicRole !== "Receptionist";

  const stats = [
    { icon: CalendarDays, value: String(appointments.length), label: "Today's appointments" },
    { icon: ClipboardList, value: String(aiDrafts.length), label: "Pending orders and drafts" },
    { icon: ListTodo, value: String(careTasks.length), label: "Unresolved tasks" },
    { icon: Users, value: String(pets.length), label: "Active patients" },
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-extrabold text-ink">
            Good morning, {roleDisplayName[clinicRole]}
          </h1>
          <p className="mt-1 text-sm text-muted">Here is what needs your attention today.</p>
        </div>
        {canDictate && (
          <Link
            href="/clinic/vox-soap"
            className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-canvas shadow-sm shadow-primary/25 transition-colors hover:bg-primary-dark"
          >
            <Mic className="h-4 w-4" />
            Open VoxSOAP Scribe
          </Link>
        )}
      </div>

      {/* Flagship VoxSOAP Quick-Start Card (discoverability & learnability) */}
      {canDictate ? (
        <section className="rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/10 via-surface to-surface p-5 sm:p-6 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-1.5 max-w-2xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/15 px-3 py-0.5 text-xs font-bold text-primary-dark">
                <Sparkles className="h-3.5 w-3.5" />
                VoxSOAP AI Scribe · Local &amp; Private
              </div>
              <h2 className="font-display text-xl font-extrabold text-ink">
                Turn a consultation into a structured SOAP note in 3 steps
              </h2>
              <p className="text-sm text-muted leading-relaxed">
                <strong className="text-ink">1. Capture</strong> mic or audio file →{" "}
                <strong className="text-ink">2. Review</strong> transcript &amp; 23-point SOAP draft →{" "}
                <strong className="text-ink">3. Confirm</strong> orders &amp; publish pet-owner care cards.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2.5 shrink-0">
              <Link
                href="/clinic/vox-soap"
                className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-canvas transition-colors hover:bg-primary-dark"
              >
                <Mic className="h-4 w-4" />
                Open VoxSOAP Scribe
              </Link>
              <Link
                href="/clinic/vox-soap?action=ml-assist"
                className="inline-flex items-center gap-2 rounded-xl border border-line bg-sidebar px-4 py-2.5 text-sm font-semibold text-ink transition-colors hover:border-primary/50 hover:text-primary-dark"
              >
                <Upload className="h-4 w-4" />
                Record or Upload Audio
              </Link>
            </div>
          </div>
        </section>
      ) : (
        <section className="rounded-2xl border border-line bg-surface p-4 text-sm text-muted">
          <strong className="text-ink">Receptionist view:</strong> You can manage check-ins, scheduling, and patient lookup. Clinical SOAP dictation is restricted to Veterinarians and Assistants (FR-6).
        </section>
      )}

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
            {appointments.map((a) => {
              const petId = petIdForName(a.petName);
              return (
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
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/clinic/patients/${petId}`}
                      className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:border-primary/50 hover:text-primary-dark"
                    >
                      View Patient
                    </Link>
                    {canDictate && (
                      <Link
                        href={`/clinic/vox-soap?petId=${petId}&action=ml-assist`}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-primary/50 bg-primary/10 px-3 py-1.5 text-xs font-bold text-primary-dark transition-colors hover:bg-primary hover:text-canvas"
                      >
                        <Mic className="h-3.5 w-3.5" />
                        Start SOAP Note
                      </Link>
                    )}
                  </div>
                </motion.li>
              );
            })}
          </ul>
        </motion.section>

        <div className="space-y-6">
          {(clinicRole === "Veterinarian" || clinicRole === "Admin") && (
            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-lg font-bold text-ink">Pending AI drafts</h2>
                <Link href="/clinic/vox-soap" className="inline-flex items-center gap-1 text-xs font-semibold text-primary-dark hover:underline">
                  Open VoxSOAP
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
              {aiDrafts.map((d) => {
                const draftPetId = petIdForName(d.petName);
                return (
                  <div key={d.id} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Link href={`/clinic/patients/${draftPetId}`} className="text-sm font-semibold text-ink hover:text-primary-dark hover:underline">
                        {d.petName}
                      </Link>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted">{d.source}</span>
                        <Link
                          href={`/clinic/vox-soap?petId=${draftPetId}`}
                          className="text-xs font-bold text-primary-dark hover:underline"
                        >
                          Review in VoxSOAP →
                        </Link>
                      </div>
                    </div>
                    <AIDraftPanel draft={d} />
                  </div>
                );
              })}
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

      {/* Scribenote-style one-tap voice recording entry (opens the capture-
          hardened New Recording panel; routes to the VoxSOAP workspace for
          review on completion). Hidden for Receptionists per FR-6. */}
      <DashboardRecordButton />
    </div>
  );
}