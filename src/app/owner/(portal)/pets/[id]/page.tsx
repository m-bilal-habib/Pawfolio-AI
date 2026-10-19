"use client";

import { motion } from "framer-motion";
import { History } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { TimelineEvent } from "@/components/cards";
import { EmptyState } from "@/components/ui";
import { eventsFor, ownerPets } from "@/lib/data";

export default function OwnerPetTimeline() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const petId = ownerPets.some((p) => p.id === params.id) ? params.id : ownerPets[0].id;
  const events = eventsFor(petId);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-extrabold text-ink">Pet timeline</h1>
        <p className="mt-1 text-sm text-muted">Every visit, vaccination, test and medicine change in one story.</p>
      </div>

      <div className="flex gap-2">
        {ownerPets.map((p) => (
          <button
            key={p.id}
            onClick={() => router.push(`/owner/pets/${p.id}`)}
            className={`rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${
              p.id === petId
                ? "border-accent bg-accent text-canvas shadow-md shadow-accent/25"
                : "border-line bg-surface text-muted hover:border-accent/50 hover:text-accent-dark"
            }`}
          >
            {p.name}
          </button>
        ))}
      </div>

      <motion.div
        key={petId}
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className="rounded-2xl border border-line bg-surface p-6 shadow-sm"
      >
        {events.length === 0 ? (
          <EmptyState
            icon={History}
            title="No events yet"
            body="Visits and vaccinations recorded by the clinic will appear here."
          />
        ) : (
          events.map((e) => <TimelineEvent key={e.id} event={e} accent="orange" />)
        )}
      </motion.div>
    </div>
  );
}