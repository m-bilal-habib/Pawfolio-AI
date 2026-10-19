"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Mic, MicOff, Plus, Stethoscope } from "lucide-react";
import { useParams } from "next/navigation";
import { useState } from "react";
import { AIDraftPanel, DocumentCard, TimelineEvent } from "@/components/cards";
import { EmptyState, StatusBadge } from "@/components/ui";
import { aiDrafts, docsFor, eventsFor, medsFor, petById } from "@/lib/data";

const tabs = ["Snapshot", "Visit Workspace", "Timeline", "Documents"] as const;
type Tab = (typeof tabs)[number];

type OrderRow = { medicine: string; dose: string; frequency: string; duration: string };
const emptyOrder: OrderRow = { medicine: "", dose: "", frequency: "", duration: "" };

export default function PatientWorkspace() {
  const params = useParams<{ id: string }>();
  const pet = petById(params.id);
  const [tab, setTab] = useState<Tab>("Snapshot");
  const [listening, setListening] = useState(false);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [order, setOrder] = useState<OrderRow>(emptyOrder);
  const [orderError, setOrderError] = useState("");
  const [complaint, setComplaint] = useState("");
  const [findings, setFindings] = useState("");
  const [weight, setWeight] = useState("");
  const [formError, setFormError] = useState("");

  if (!pet) {
    return (
      <EmptyState icon={Stethoscope} title="Patient not found" body="This patient record does not exist in the demo data." />
    );
  }

  const events = eventsFor(pet.id);
  const meds = medsFor(pet.id);
  const docs = docsFor(pet.id);
  const draft = aiDrafts.find((d) => d.petName === pet.name) ?? aiDrafts[0];

  const addOrder = () => {
    if (!order.medicine.trim() || !order.dose.trim() || !order.frequency.trim() || !order.duration.trim()) {
      setOrderError("Medicine, dose, frequency and duration are all required before an order can be added.");
      return;
    }
    setOrderError("");
    setOrders((prev) => [...prev, order]);
    setOrder(emptyOrder);
  };

  const saveVisit = () => {
    if (!complaint.trim() || !weight.trim()) {
      setFormError("Presenting complaint and weight are required to save the visit note.");
      return;
    }
    setFormError("");
  };

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-line bg-surface p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 font-display text-xl font-extrabold text-primary-dark">
              {pet.name.charAt(0)}
            </span>
            <div>
              <h1 className="font-display text-2xl font-extrabold text-ink">{pet.name}</h1>
              <p className="text-sm text-muted">
                {pet.species}, {pet.breed} · {pet.age} · {pet.weight}
              </p>
              <p className="text-sm text-muted">
                {pet.owner} · {pet.household}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {pet.badges.map((b) => (
              <span
                key={b}
                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  b === "Allergies"
                    ? "bg-error/10 text-red-400"
                    : b === "Under treatment"
                      ? "bg-warning/25 text-yellow-300"
                      : "bg-success/10 text-green-300"
                }`}
              >
                {b}
              </span>
            ))}
          </div>
        </div>

        <div className="mt-6 flex gap-6 border-b border-line">
          {tabs.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`relative pb-3 text-sm font-semibold transition-colors ${
                tab === t ? "text-primary-dark" : "text-muted hover:text-ink"
              }`}
            >
              {t}
              {tab === t && (
                <motion.span
                  layoutId="patient-tab-underline"
                  className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-primary"
                  transition={{ type: "spring", stiffness: 400, damping: 32 }}
                />
              )}
            </button>
          ))}
        </div>
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
        >
          {tab === "Snapshot" && (
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm">
                <h2 className="font-display text-lg font-bold text-ink">Allergies and conditions</h2>
                <div className="mt-3 flex flex-wrap gap-2">
                  {pet.allergies.length === 0 && pet.conditions.length === 0 ? (
                    <p className="text-sm text-muted">No allergies or chronic conditions on record.</p>
                  ) : (
                    <>
                      {pet.allergies.map((a) => (
                        <span key={a} className="rounded-full bg-error/10 px-3 py-1 text-sm font-semibold text-red-400">
                          Allergy: {a}
                        </span>
                      ))}
                      {pet.conditions.map((c) => (
                        <span key={c} className="rounded-full bg-warning/25 px-3 py-1 text-sm font-semibold text-yellow-300">
                          {c}
                        </span>
                      ))}
                    </>
                  )}
                </div>
                <h3 className="mt-6 text-sm font-semibold uppercase tracking-wide text-muted">Active medications</h3>
                <div className="mt-2 flex flex-wrap gap-2">
                  {meds.length === 0 ? (
                    <p className="text-sm text-muted">No active medications.</p>
                  ) : (
                    meds.map((m) => (
                      <span key={m.id} className="rounded-full bg-primary/10 px-3 py-1 text-sm font-semibold text-primary-dark">
                        {m.name}
                      </span>
                    ))
                  )}
                </div>
              </div>
              <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm">
                <h2 className="font-display text-lg font-bold text-ink">Recent visits</h2>
                <ul className="mt-4 space-y-3">
                  {events.slice(0, 3).map((e) => (
                    <li key={e.id} className="flex items-center justify-between rounded-xl bg-sidebar px-4 py-3">
                      <div>
                        <p className="text-sm font-semibold text-ink">{e.title}</p>
                        <p className="text-xs text-muted">{e.vet}</p>
                      </div>
                      <span className="text-xs font-medium text-muted">{e.date}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {tab === "Visit Workspace" && (
            <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
              <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm">
                <div className="flex items-center justify-between">
                  <h2 className="font-display text-lg font-bold text-ink">Consultation note</h2>
                  <motion.button
                    whileTap={{ scale: 0.95 }}
                    onClick={() => setListening((v) => !v)}
                    className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
                      listening ? "bg-error text-white" : "bg-primary/10 text-primary-dark hover:bg-primary hover:text-canvas"
                    }`}
                  >
                    {listening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                    {listening ? "Stop dictation" : "Dictate note"}
                  </motion.button>
                </div>
                {listening && (
                  <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="mt-3 flex items-center gap-2 rounded-lg bg-primary/10 px-3 py-2 text-sm font-medium text-primary-dark"
                  >
                    <span className="h-2 w-2 animate-pulse rounded-full bg-error" />
                    Listening. Speech is transcribed into the draft panel for review.
                  </motion.p>
                )}

                <div className="mt-4 space-y-4">
                  <div>
                    <label className="text-sm font-semibold text-ink" htmlFor="complaint">
                      Presenting complaint
                    </label>
                    <textarea
                      id="complaint"
                      value={complaint}
                      onChange={(e) => setComplaint(e.target.value)}
                      rows={2}
                      placeholder="What brought the pet in today?"
                      className="mt-1.5 w-full rounded-lg border border-line bg-canvas px-3.5 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-muted/60 focus:border-primary focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-ink" htmlFor="findings">
                      Examination findings
                    </label>
                    <textarea
                      id="findings"
                      value={findings}
                      onChange={(e) => setFindings(e.target.value)}
                      rows={3}
                      placeholder="Objective findings from the examination"
                      className="mt-1.5 w-full rounded-lg border border-line bg-canvas px-3.5 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-muted/60 focus:border-primary focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                  <div className="max-w-[180px]">
                    <label className="text-sm font-semibold text-ink" htmlFor="weight">
                      Weight (kg)
                    </label>
                    <input
                      id="weight"
                      value={weight}
                      onChange={(e) => setWeight(e.target.value)}
                      placeholder="0.0"
                      className="mt-1.5 w-full rounded-lg border border-line bg-canvas px-3.5 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-muted/60 focus:border-primary focus:ring-2 focus:ring-primary/20"
                    />
                  </div>

                  <div className="rounded-xl bg-sidebar p-4">
                    <h3 className="text-sm font-bold text-ink">Medication orders</h3>
                    <div className="mt-3 grid gap-2 sm:grid-cols-4">
                      {(Object.keys(order) as (keyof OrderRow)[]).map((field) => (
                        <input
                          key={field}
                          value={order[field]}
                          onChange={(e) => setOrder((o) => ({ ...o, [field]: e.target.value }))}
                          placeholder={field.charAt(0).toUpperCase() + field.slice(1)}
                          className="rounded-lg border border-line bg-surface px-3 py-2 text-sm capitalize text-ink outline-none transition-colors placeholder:text-muted/60 focus:border-primary focus:ring-2 focus:ring-primary/20"
                        />
                      ))}
                    </div>
                    {orderError && <p className="mt-2 text-xs font-medium text-red-400">{orderError}</p>}
                    <button
                      onClick={addOrder}
                      className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-primary px-3.5 py-2 text-sm font-semibold text-primary-dark transition-colors hover:bg-primary hover:text-canvas"
                    >
                      <Plus className="h-4 w-4" />
                      Add order row
                    </button>
                    {orders.length > 0 && (
                      <ul className="mt-3 space-y-2">
                        {orders.map((o, i) => (
                          <li key={i} className="flex items-center justify-between rounded-lg bg-surface px-3 py-2 text-sm">
                            <span className="font-medium text-ink">{o.medicine}</span>
                            <span className="text-muted">
                              {o.dose} · {o.frequency} · {o.duration}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {formError && <p className="text-sm font-medium text-red-400">{formError}</p>}
                  <button
                    onClick={saveVisit}
                    className="rounded-lg bg-primary px-5 py-2.5 text-sm font-bold text-canvas transition-colors hover:bg-primary-dark"
                  >
                    Save note and send orders for confirmation
                  </button>
                </div>
              </div>

              <div>
                <AIDraftPanel draft={draft} />
                <p className="mt-3 text-xs leading-relaxed text-muted">
                  Draft fields come from dictation and uploaded reports. Nothing here enters the record until a
                  veterinarian confirms it.
                </p>
              </div>
            </div>
          )}

          {tab === "Timeline" && (
            <div className="rounded-2xl border border-line bg-surface p-6 shadow-sm">
              {events.length === 0 ? (
                <EmptyState icon={Stethoscope} title="No events yet" body="Visits, vaccinations, tests and medication changes will appear here." />
              ) : (
                events.map((e) => <TimelineEvent key={e.id} event={e} />)
              )}
            </div>
          )}

          {tab === "Documents" && (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {docs.length === 0 ? (
                <div className="sm:col-span-2 xl:col-span-3">
                  <EmptyState icon={Stethoscope} title="No documents yet" body="Uploaded reports and their review status will appear here." />
                </div>
              ) : (
                docs.map((d) => (
                  <div key={d.id}>
                    <DocumentCard doc={d} />
                    <div className="mt-2">
                      <StatusBadge status={d.status} />
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}