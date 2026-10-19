"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Upload } from "lucide-react";
import { useState } from "react";
import { DocumentCard } from "@/components/cards";
import { staggerChild, staggerParent } from "@/components/ui";
import { docsFor, ownerPets, type Doc } from "@/lib/data";

export default function OwnerDocuments() {
  const [uploads, setUploads] = useState<Doc[]>([]);
  const [notice, setNotice] = useState("");

  const simulateUpload = () => {
    const next: Doc = {
      id: `up${uploads.length + 1}`,
      petId: ownerPets[0].id,
      name: `New upload ${uploads.length + 1}: lab photo`,
      kind: "Image",
      date: "16 Oct 2026",
      status: "Unverified",
    };
    setUploads((prev) => [next, ...prev]);
    setNotice("Upload received. It stays unverified until the clinic reviews it.");
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-3xl font-extrabold text-ink">Documents</h1>
        <p className="mt-1 text-sm text-muted">Reports and photos for your pets, with their review status.</p>
      </div>

      <button
        onClick={simulateUpload}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          simulateUpload();
        }}
        className="flex w-full flex-col items-center rounded-2xl border-2 border-dashed border-accent/40 bg-accent/5 px-6 py-10 text-center transition-colors hover:border-accent hover:bg-accent/10"
      >
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-accent/10 text-accent-dark">
          <Upload className="h-7 w-7" />
        </span>
        <p className="mt-4 font-display text-lg font-bold text-ink">Drop a report here, or tap to upload</p>
        <p className="mt-1 text-sm text-muted">Photos and PDFs are kept with their original file and review status.</p>
      </button>

      <AnimatePresence>
        {notice && (
          <motion.p
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="rounded-lg bg-warning/20 px-4 py-2.5 text-sm font-semibold text-yellow-300"
          >
            {notice}
          </motion.p>
        )}
      </AnimatePresence>

      {ownerPets.map((pet) => {
        const docs = [...uploads.filter((d) => d.petId === pet.id), ...docsFor(pet.id)];
        return (
          <section key={pet.id} className="space-y-4">
            <h2 className="font-display text-lg font-bold text-ink">{pet.name}</h2>
            <motion.div variants={staggerParent} initial="hidden" whileInView="show" viewport={{ once: true }} className="grid gap-4 sm:grid-cols-2">
              {docs.map((d) => (
                <motion.div key={d.id} variants={staggerChild}>
                  <DocumentCard doc={d} />
                </motion.div>
              ))}
            </motion.div>
          </section>
        );
      })}
    </div>
  );
}