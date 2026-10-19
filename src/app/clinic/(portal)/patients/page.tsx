"use client";

import { motion } from "framer-motion";
import { Search, Users } from "lucide-react";
import { useState } from "react";
import { PatientCard } from "@/components/cards";
import { EmptyState, staggerChild, staggerParent } from "@/components/ui";
import { pets } from "@/lib/data";

export default function PatientsPage() {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const results = pets.filter(
    (p) =>
      p.name.toLowerCase().includes(q) ||
      p.owner.toLowerCase().includes(q) ||
      p.breed.toLowerCase().includes(q)
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-extrabold text-ink">Patients</h1>
          <p className="mt-1 text-sm text-muted">Search by pet name, owner or breed.</p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search patients"
            className="w-full rounded-full border border-line bg-surface py-2.5 pl-10 pr-4 text-sm text-ink outline-none transition-colors placeholder:text-muted/60 focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </div>
      </div>

      {results.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No patients match that search"
          body="Try a different pet name, owner name or breed."
        />
      ) : (
        <motion.div variants={staggerParent} initial="hidden" animate="show" className="space-y-3">
          {results.map((p) => (
            <motion.div key={p.id} variants={staggerChild}>
              <PatientCard pet={p} />
            </motion.div>
          ))}
        </motion.div>
      )}
    </div>
  );
}