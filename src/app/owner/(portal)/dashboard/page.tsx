"use client";

import { motion } from "framer-motion";
import { CalendarDays, PawPrint } from "lucide-react";
import { useState } from "react";
import { DoseCard } from "@/components/cards";
import { EmptyState, staggerChild, staggerParent } from "@/components/ui";
import { ownerPets, todayActions } from "@/lib/data";

export default function OwnerDashboard() {
  const [petId, setPetId] = useState(ownerPets[0].id);
  const actions = todayActions.filter((a) => a.petId === petId);
  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-3xl font-extrabold text-ink">Good morning, Ali</h1>
        <p className="mt-1 text-sm text-muted">{today}</p>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {ownerPets.map((p) => (
          <button
            key={p.id}
            onClick={() => setPetId(p.id)}
            className={`flex shrink-0 items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${
              petId === p.id
                ? "border-accent bg-accent text-canvas shadow-md shadow-accent/25"
                : "border-line bg-surface text-muted hover:border-accent/50 hover:text-accent-dark"
            }`}
          >
            <PawPrint className="h-4 w-4" />
            {p.name}
          </button>
        ))}
      </div>

      <section className="space-y-4">
        <h2 className="font-display text-lg font-bold text-ink">Today&apos;s care actions</h2>
        {actions.length === 0 ? (
          <EmptyState
            icon={PawPrint}
            title={`Nothing due for ${ownerPets.find((p) => p.id === petId)?.name} today`}
            body="When the clinic confirms a new order, the care card and schedule will appear here."
          />
        ) : (
          <motion.div variants={staggerParent} initial="hidden" animate="show" className="grid gap-4 sm:grid-cols-2">
            {actions.map((a) => (
              <motion.div key={a.id} variants={staggerChild}>
                <DoseCard action={a} />
              </motion.div>
            ))}
          </motion.div>
        )}
      </section>

      <motion.section
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2, duration: 0.4, ease: "easeOut" }}
        className="flex items-center gap-4 rounded-2xl border border-accent/25 bg-accent/5 p-5"
      >
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent-dark">
          <CalendarDays className="h-5 w-5" />
        </span>
        <div>
          <p className="font-semibold text-ink">Recheck visit on Friday, 09:30</p>
          <p className="text-sm text-muted">Pawfolio Partner Clinic with Dr. Ahmed. Bring the ear drop bottle.</p>
        </div>
      </motion.section>
    </div>
  );
}