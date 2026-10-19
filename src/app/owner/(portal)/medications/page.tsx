"use client";

import { motion } from "framer-motion";
import { Pill } from "lucide-react";
import { MedCard } from "@/components/cards";
import { EmptyState, staggerChild, staggerParent } from "@/components/ui";
import { medsFor, ownerPets } from "@/lib/data";

export default function OwnerMedications() {
  const withMeds = ownerPets.map((p) => ({ pet: p, meds: medsFor(p.id) }));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-3xl font-extrabold text-ink">Medication schedule</h1>
        <p className="mt-1 text-sm text-muted">Active courses, progress and the last seven days of dose logs.</p>
      </div>

      {withMeds.every((g) => g.meds.length === 0) ? (
        <EmptyState
          icon={Pill}
          title="No active medications"
          body="Confirmed orders from the clinic will show up here with their schedule."
        />
      ) : (
        withMeds.map((group) => (
          <section key={group.pet.id} className="space-y-4">
            <h2 className="font-display text-lg font-bold text-ink">{group.pet.name}</h2>
            {group.meds.length === 0 ? (
              <p className="rounded-xl border border-dashed border-line bg-white/[0.03] px-4 py-6 text-center text-sm text-muted">
                No active medication for {group.pet.name} right now.
              </p>
            ) : (
              <motion.div variants={staggerParent} initial="hidden" whileInView="show" viewport={{ once: true }} className="grid gap-4 sm:grid-cols-2">
                {group.meds.map((m) => (
                  <motion.div key={m.id} variants={staggerChild}>
                    <MedCard med={m} />
                  </motion.div>
                ))}
              </motion.div>
            )}
          </section>
        ))
      )}
    </div>
  );
}