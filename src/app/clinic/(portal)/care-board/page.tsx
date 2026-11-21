"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Check, Clock, Mic, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { CareTaskCard } from "@/components/cards";
import { EmptyState, OwnerReportedLabel, staggerChild, staggerParent } from "@/components/ui";
import { careOrders, careTasks, pets } from "@/lib/data";

function petIdForName(petName: string): string {
  return pets.find((p) => p.name.toLowerCase() === petName.toLowerCase())?.id ?? "buddy";
}

const logIcon = {
  Given: Check,
  Skipped: X,
  Pending: Clock,
} as const;

const logStyle = {
  Given: "bg-success/10 text-green-300",
  Skipped: "bg-error/10 text-red-400",
  Pending: "bg-white/5 text-muted",
} as const;

export default function CareBoard() {
  const [tasks, setTasks] = useState(careTasks);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-extrabold text-ink">Care Board</h1>
          <p className="mt-1 text-sm text-muted">Confirmed care on the left, open work on the right.</p>
        </div>
        <Link
          href="/clinic/vox-soap"
          className="inline-flex items-center gap-2 rounded-full border border-primary/50 bg-primary/10 px-4 py-2 text-xs font-bold text-primary-dark transition-colors hover:bg-primary hover:text-canvas"
        >
          <Mic className="h-3.5 w-3.5" />
          Open VoxSOAP Scribe
        </Link>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <motion.section variants={staggerParent} initial="hidden" animate="show" className="space-y-4">
          <h2 className="font-display text-lg font-bold text-ink">Confirmed care</h2>
          {careOrders.map((o) => {
            const petId = petIdForName(o.petName);
            return (
            <motion.div key={o.id} variants={staggerChild} className="rounded-2xl border border-line bg-surface p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold text-ink">
                  <Link href={`/clinic/patients/${petId}`} className="hover:text-primary-dark hover:underline">
                    {o.petName}
                  </Link>
                  <span className="ml-2 text-sm font-normal text-muted">{o.medicine}</span>
                </p>
                <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary-dark">
                  Next due {o.nextDue}
                </span>
              </div>
              <p className="mt-1 text-sm text-muted">
                {o.dose} · {o.frequency}
              </p>
              <div className="mt-3">
                <OwnerReportedLabel />
              </div>
              <ul className="mt-3 space-y-2">
                {o.logs.map((l, i) => {
                  const Icon = logIcon[l.status];
                  return (
                    <li key={i} className="flex items-center justify-between rounded-lg bg-sidebar px-3 py-2 text-sm">
                      <span className="text-muted">{l.who}</span>
                      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${logStyle[l.status]}`}>
                        <Icon className="h-3.5 w-3.5" />
                        {l.status} · {l.at}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </motion.div>
            );
          })}
        </motion.section>

        <section className="space-y-4">
          <h2 className="font-display text-lg font-bold text-ink">Unresolved tasks</h2>
          <AnimatePresence initial={false}>
            {tasks.length === 0 ? (
              <EmptyState icon={Check} title="Queue clear" body="Every refill request, owner note and follow-up has been resolved." />
            ) : (
              tasks.map((t) => (
                <CareTaskCard key={t.id} task={t} onResolve={(id) => setTasks((prev) => prev.filter((x) => x.id !== id))} />
              ))
            )}
          </AnimatePresence>
        </section>
      </div>
    </div>
  );
}