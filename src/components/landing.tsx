"use client";

import { AnimatePresence, motion, useInView } from "framer-motion";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Cat,
  Check,
  ClipboardList,
  Dog,
  FileText,
  Lock,
  Mail,
  MapPin,
  Mic,
  PawPrint,
  Phone,
  Pill,
  Search,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Stethoscope,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  docsFor,
  eventsFor,
  medsFor,
  pets,
  todayActions,
  type Pet,
} from "@/lib/data";
import { DoseCard, DocumentCard, TimelineEvent } from "./cards";
import { StatusBadge } from "./ui";

const navLinks = [
  { href: "#how-it-works", label: "How it Works" },
  { href: "#patients", label: "Patients" },
  { href: "#services", label: "Services" },
  { href: "#for-clinics", label: "For Clinics" },
  { href: "#for-owners", label: "For Owners" },
  { href: "#contact", label: "Contact" },
];

function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-40 transition-all duration-300 ${
        scrolled || open
          ? "border-b border-line bg-canvas/85 backdrop-blur-md"
          : "border-b border-transparent bg-transparent"
      }`}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="#top" className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-canvas">
            <PawPrint className="h-5 w-5" />
          </span>
          <span className="font-display text-lg font-extrabold tracking-tight text-ink">
            Pawfolio <span className="text-primary">AI</span>
          </span>
        </Link>

        <nav className="hidden items-center gap-7 lg:flex">
          {navLinks.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="text-sm font-medium text-muted transition-colors hover:text-ink"
            >
              {l.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-3 lg:flex">
          <Link
            href="/clinic/login"
            className="rounded-full border border-primary/60 px-4 py-2 text-sm font-semibold text-primary-dark transition-colors hover:bg-primary hover:text-canvas"
          >
            Clinic Login
          </Link>
          <Link
            href="/owner/login"
            className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-canvas transition-colors hover:bg-accent-dark"
          >
            Pet Owner Login
          </Link>
        </div>

        <button
          onClick={() => setOpen((v) => !v)}
          aria-label="Toggle menu"
          className="flex h-10 w-10 items-center justify-center rounded-lg border border-line text-muted transition-colors hover:text-ink lg:hidden"
        >
          {open ? <X className="h-5 w-5" /> : <Activity className="h-5 w-5" />}
        </button>
      </div>

      <AnimatePresence>
        {open && (
          <motion.nav
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden border-t border-line bg-canvas/95 backdrop-blur-md lg:hidden"
          >
            <div className="space-y-1 px-6 py-4">
              {navLinks.map((l) => (
                <a
                  key={l.href}
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className="block rounded-lg px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-surface hover:text-ink"
                >
                  {l.label}
                </a>
              ))}
              <div className="flex gap-3 pt-2">
                <Link
                  href="/clinic/login"
                  className="flex-1 rounded-full border border-primary/60 px-4 py-2 text-center text-sm font-semibold text-primary-dark"
                >
                  Clinic Login
                </Link>
                <Link
                  href="/owner/login"
                  className="flex-1 rounded-full bg-accent px-4 py-2 text-center text-sm font-semibold text-canvas"
                >
                  Pet Owner Login
                </Link>
              </div>
            </div>
          </motion.nav>
        )}
      </AnimatePresence>
    </header>
  );
}

type Slide = {
  kicker: string;
  title: string;
  body: string;
  visual: "record" | "draft" | "home" | "query";
};

const slides: Slide[] = [
  {
    kicker: "one record,",
    title: "every visit remembered.",
    body: "Visits, vaccinations, tests and medicines live in one structured record that the clinic verifies and the home can finally see.",
    visual: "record",
  },
  {
    kicker: "AI drafts,",
    title: "the vet decides.",
    body: "Dictation and uploaded reports become structured drafts with missing values flagged. Nothing enters the record until a veterinarian confirms it.",
    visual: "draft",
  },
  {
    kicker: "clear plans,",
    title: "calm homes.",
    body: "Confirmed orders turn into plain language care cards, dose schedules and reminders on the owner phone, generated by fixed rules.",
    visual: "home",
  },
  {
    kicker: "ask anything,",
    title: "answers with sources.",
    body: "Ask when the last vaccination was and get a plain answer linked to the exact visit note it came from.",
    visual: "query",
  },
];

function HeroVisual({ variant }: { variant: Slide["visual"] }) {
  return (
    <div className="relative mx-auto w-full max-w-md">
      <div
        aria-hidden
        className="absolute inset-0 -z-10 rounded-full bg-primary/15 blur-3xl"
      />
      <PawPrint className="animate-float absolute -top-8 -left-6 h-10 w-10 text-primary/30" />
      <PawPrint className="animate-float-slow absolute -right-4 -bottom-6 h-8 w-8 text-accent/30" />

      <motion.div
        key={variant}
        initial={{ opacity: 0, y: 24, rotate: -1.5 }}
        animate={{ opacity: 1, y: 0, rotate: 0 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className="rounded-2xl border border-line bg-surface/90 p-5 shadow-2xl shadow-black/40 backdrop-blur"
      >
        {variant === "record" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/15 font-display text-lg font-extrabold text-primary-dark">
                  B
                </span>
                <div>
                  <p className="font-display font-bold text-ink">Buddy</p>
                  <p className="text-xs text-muted">Dog, Golden Retriever, 4 years</p>
                </div>
              </div>
              <StatusBadge status="Verified" />
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              {[
                ["Weight", "28.4 kg"],
                ["Allergies", "Penicillin"],
                ["Last visit", "14 Oct"],
              ].map(([k, v]) => (
                <div key={k} className="rounded-lg bg-white/5 px-2 py-2">
                  <p className="text-[10px] uppercase tracking-wide text-muted">{k}</p>
                  <p className="mt-0.5 text-xs font-semibold text-ink">{v}</p>
                </div>
              ))}
            </div>
            <div className="space-y-2">
              {["Ear infection consultation", "Ear cytology and skin scrap", "Annual booster"].map(
                (t, i) => (
                  <div key={t} className="flex items-center gap-2 text-xs text-muted">
                    <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                    {t}
                    <span className="ml-auto text-[10px] text-muted/70">{i === 0 ? "latest" : ""}</span>
                  </div>
                )
              )}
            </div>
          </div>
        )}

        {variant === "draft" && (
          <div className="space-y-3">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning/15 px-2.5 py-1 text-xs font-semibold text-yellow-300">
              <Sparkles className="h-3.5 w-3.5" />
              AI Draft: Pending Review
            </span>
            {[
              ["Complaint", "Ear redness, head shaking", true],
              ["Weight", "28.4 kg", true],
              ["Medicine", "Amoxicillin 500 mg", true],
              ["Duration", "Missing, flagged", false],
            ].map(([label, value, ok]) => (
              <div key={label as string} className="flex items-center justify-between text-sm">
                <span className="text-muted">{label}</span>
                <span className="flex items-center gap-1.5 font-medium text-ink">
                  {ok ? (
                    <Check className="h-4 w-4 text-success" />
                  ) : (
                    <X className="h-4 w-4 text-warning" />
                  )}
                  {value}
                </span>
              </div>
            ))}
            <p className="rounded-lg bg-primary/10 px-3 py-2 text-xs font-semibold text-primary-dark">
              Waiting for veterinarian confirmation
            </p>
          </div>
        )}

        {variant === "home" && (
          <div className="space-y-3">
            <p className="font-display font-bold text-ink">Today at home</p>
            {[
              ["08:00", "Amoxicillin 500 mg", "Given 08:12"],
              ["08:00", "Ear drops, 2 per ear", "Given 08:15"],
              ["20:00", "Amoxicillin 500 mg", "Up next"],
            ].map(([time, med, state]) => (
              <div
                key={time + med}
                className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2.5"
              >
                <div>
                  <p className="text-sm font-semibold text-ink">{med}</p>
                  <p className="text-[11px] text-muted">due {time}</p>
                </div>
                <span
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                    state === "Up next"
                      ? "bg-primary/15 text-primary-dark"
                      : "bg-success/15 text-green-300"
                  }`}
                >
                  {state}
                </span>
              </div>
            ))}
            <p className="text-xs text-muted">Logged at home, visible to the clinic as owner reported.</p>
          </div>
        )}

        {variant === "query" && (
          <div className="space-y-3">
            <div className="rounded-lg bg-white/5 px-3 py-2.5 text-sm text-ink">
              When was Buddy last vaccinated?
            </div>
            <div className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2.5">
              <p className="text-sm text-ink">
                02 Sep 2026, DHPP and rabies booster at Pawfolio Partner Clinic.
              </p>
              <p className="mt-1.5 inline-flex items-center gap-1 text-xs font-semibold text-primary-dark">
                <FileText className="h-3.5 w-3.5" />
                Source: visit note, 02 Sep 2026
              </p>
            </div>
            <p className="text-xs text-muted">
              Questions about diagnosis or dosing are declined, always.
            </p>
          </div>
        )}
      </motion.div>
    </div>
  );
}

function Hero() {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % slides.length), 6000);
    return () => clearInterval(id);
  }, [paused]);

  const slide = slides[index];

  return (
    <section
      id="top"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className="relative overflow-hidden pt-28 pb-16 md:pt-36 md:pb-24"
    >
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -top-40 right-0 h-[420px] w-[420px] rounded-full bg-primary/10 blur-3xl" />
        <div className="absolute bottom-0 -left-32 h-[320px] w-[320px] rounded-full bg-accent/10 blur-3xl" />
      </div>

      <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-6 md:grid-cols-2">
        <AnimatePresence mode="wait">
          <motion.div
            key={index}
            initial={{ opacity: 0, y: 28 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
          >
            <p className="font-accent text-3xl italic text-accent-dark md:text-4xl">
              {slide.kicker}
            </p>
            <h1 className="font-display mt-2 text-5xl font-extrabold tracking-tight text-ink md:text-6xl">
              {slide.title}
            </h1>

            <div className="mt-8 flex items-start gap-5">
              <p className="font-display text-2xl font-extrabold text-primary">
                0{index + 1}
                <span className="ml-0.5 text-sm font-semibold text-muted">/0{slides.length}</span>
              </p>
              <p className="max-w-sm text-sm leading-relaxed text-muted">{slide.body}</p>
            </div>

            <div className="mt-9 flex flex-wrap gap-3">
              <a
                href="#how-it-works"
                className="inline-flex items-center gap-2 rounded-full bg-primary px-6 py-3 text-sm font-bold text-canvas transition-all hover:gap-3 hover:bg-primary-dark"
              >
                See how it works
                <ArrowRight className="h-4 w-4" />
              </a>
              <a
                href="#patients"
                className="inline-flex items-center gap-2 rounded-full border border-line px-6 py-3 text-sm font-semibold text-muted transition-colors hover:border-primary/50 hover:text-ink"
              >
                Meet the patients
              </a>
            </div>
          </motion.div>
        </AnimatePresence>

        <HeroVisual variant={slide.visual} />
      </div>

      <button
        aria-label="Previous slide"
        onClick={() => setIndex((i) => (i - 1 + slides.length) % slides.length)}
        className="absolute top-1/2 left-3 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-line text-muted transition-colors hover:border-primary/60 hover:text-primary-dark md:flex"
      >
        <ArrowLeft className="h-5 w-5" />
      </button>
      <button
        aria-label="Next slide"
        onClick={() => setIndex((i) => (i + 1) % slides.length)}
        className="absolute top-1/2 right-3 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-line text-muted transition-colors hover:border-primary/60 hover:text-primary-dark md:flex"
      >
        <ArrowRight className="h-5 w-5" />
      </button>

      <div className="mt-14 flex justify-center gap-2.5">
        {slides.map((s, i) => (
          <button
            key={s.title}
            aria-label={`Go to slide ${i + 1}`}
            onClick={() => setIndex(i)}
            className={`h-2 rounded-full transition-all duration-300 ${
              i === index ? "w-8 bg-primary" : "w-2 bg-line hover:bg-muted"
            }`}
          />
        ))}
      </div>
    </section>
  );
}

const steps = [
  {
    icon: Stethoscope,
    title: "Vet records the visit",
    body: "Structured notes and dictation capture the consultation once, in a form software can reuse.",
  },
  {
    icon: Check,
    title: "Orders confirmed",
    body: "Medication, test and follow-up orders are validated for completeness and confirmed by the veterinarian.",
  },
  {
    icon: ClipboardList,
    title: "Care cards generated",
    body: "Fixed rules turn each confirmed order into a plain language care card and a dose schedule.",
  },
  {
    icon: Smartphone,
    title: "Owner gets clear instructions",
    body: "The Today screen lists exactly what to give, when, and what to watch for at home.",
  },
  {
    icon: Activity,
    title: "Logs return to the clinic",
    body: "Given and skipped doses flow back to the care board, labelled as owner reported.",
  },
  {
    icon: Sparkles,
    title: "AI summarizes and answers",
    body: "Timelines, adherence summaries and record questions, every answer linked to its source.",
  },
];

function HowItWorks() {
  const [active, setActive] = useState(0);
  const step = steps[active];

  return (
    <section id="how-it-works" className="scroll-mt-20 py-20 md:py-28">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="font-accent text-xl italic text-accent-dark">the whole loop</p>
          <h2 className="font-display mt-2 text-3xl font-extrabold text-ink md:text-4xl">
            How Pawfolio AI works
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-muted">
            Six steps from a spoken visit note to a dose logged at home and back to the
            clinic. Tap any step to read what happens inside it.
          </p>
        </div>

        <div className="relative mt-14">
          <div aria-hidden className="absolute top-2 right-0 left-0 hidden h-px bg-line md:block" />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:flex md:justify-between">
            {steps.map((s, i) => (
              <button
                key={s.title}
                onClick={() => setActive(i)}
                className="group relative flex flex-col items-center gap-3 md:w-24"
              >
                <span
                  className={`flex h-4 w-4 items-center justify-center rounded-full border-2 transition-all duration-300 ${
                    i === active
                      ? "scale-125 border-primary bg-primary"
                      : "border-muted bg-canvas group-hover:border-primary"
                  }`}
                />
                <span
                  className={`text-center text-xs font-semibold transition-colors ${
                    i === active ? "text-primary-dark" : "text-muted group-hover:text-ink"
                  }`}
                >
                  {s.title}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="mx-auto mt-10 max-w-2xl">
          <AnimatePresence mode="wait">
            <motion.div
              key={active}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.35, ease: "easeOut" }}
              className="flex items-start gap-5 rounded-2xl border border-line bg-surface p-6 shadow-lg shadow-black/20"
            >
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary-dark">
                <step.icon className="h-6 w-6" />
              </span>
              <div>
                <p className="text-xs font-semibold tracking-widest text-muted uppercase">
                  Step 0{active + 1}
                </p>
                <h3 className="font-display mt-1 text-lg font-bold text-ink">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{step.body}</p>
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </section>
  );
}

const filters = ["All", "Dogs", "Cats"] as const;

function PatientGallery() {
  const [filter, setFilter] = useState<(typeof filters)[number]>("All");
  const [selected, setSelected] = useState<Pet | null>(null);

  const list = pets.filter((p) =>
    filter === "All" ? true : filter === "Dogs" ? p.species === "Dog" : p.species === "Cat"
  );

  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  return (
    <section id="patients" className="scroll-mt-20 bg-abyss py-20 md:py-28">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="font-accent text-xl italic text-accent-dark">waiting for review</p>
          <h2 className="font-display mt-2 text-3xl font-extrabold text-ink md:text-4xl">
            Patients on the platform
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-muted">
            A look at the kind of records Pawfolio AI keeps. Filter by species, then open
            any patient to see the timeline, medications and documents the clinic and the
            home share.
          </p>
        </div>

        <div className="mt-10 flex flex-wrap justify-center gap-3">
          {filters.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-full border px-6 py-2 text-sm font-semibold transition-all duration-300 ${
                filter === f
                  ? "border-primary bg-primary text-canvas shadow-lg shadow-primary/20"
                  : "border-line text-muted hover:border-primary/50 hover:text-ink"
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        <motion.div
          layout
          className="mt-14 grid gap-8 sm:grid-cols-2 lg:grid-cols-4"
        >
          <AnimatePresence mode="popLayout">
            {list.map((p, i) => (
              <motion.button
                layout
                key={p.id}
                initial={{ opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.94 }}
                transition={{ duration: 0.35, ease: "easeOut", delay: i * 0.05 }}
                onClick={() => setSelected(p)}
                className={`group text-center ${i % 2 === 1 ? "lg:mt-12" : ""}`}
              >
                <p className="font-display font-bold text-ink">{p.name}</p>
                <p className="text-xs text-muted">{p.age}</p>
                <div className="mt-3 flex h-40 items-center justify-center rounded-2xl border border-line bg-surface transition-all duration-300 group-hover:-translate-y-2 group-hover:border-primary/50 group-hover:shadow-xl group-hover:shadow-primary/10">
                  <span className="flex h-20 w-20 items-center justify-center rounded-full border border-line bg-gradient-to-br from-primary/25 to-accent/20">
                    {p.species === "Dog" ? (
                      <Dog className="h-9 w-9 text-primary-dark" />
                    ) : (
                      <Cat className="h-9 w-9 text-accent-dark" />
                    )}
                  </span>
                </div>
                <p className="mt-3 text-xs text-muted">{p.breed}</p>
              </motion.button>
            ))}
          </AnimatePresence>
        </motion.div>
      </div>

      <AnimatePresence>
        {selected && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelected(null)}
              className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, y: 40, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 24, scale: 0.97 }}
              transition={{ duration: 0.35, ease: "easeOut" }}
              className="relative max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-line bg-surface p-6 shadow-2xl shadow-black/50 md:p-8"
            >
              <button
                onClick={() => setSelected(null)}
                aria-label="Close patient details"
                className="absolute top-4 right-4 flex h-9 w-9 items-center justify-center rounded-full border border-line text-muted transition-colors hover:text-ink"
              >
                <X className="h-4 w-4" />
              </button>

              <div className="flex items-center gap-4">
                <span className="flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-primary/25 to-accent/20">
                  {selected.species === "Dog" ? (
                    <Dog className="h-7 w-7 text-primary-dark" />
                  ) : (
                    <Cat className="h-7 w-7 text-accent-dark" />
                  )}
                </span>
                <div>
                  <h3 className="font-display text-2xl font-extrabold text-ink">{selected.name}</h3>
                  <p className="text-sm text-muted">
                    {selected.species}, {selected.breed}, {selected.age}, {selected.weight}
                  </p>
                </div>
                <div className="ml-auto hidden sm:block">
                  <StatusBadge status="Verified" />
                </div>
              </div>

              <p className="mt-3 text-sm text-muted">
                Owner {selected.owner}, {selected.household}.
                {selected.allergies.length > 0 && ` Allergies: ${selected.allergies.join(", ")}.`}
              </p>

              <h4 className="font-display mt-7 mb-4 text-sm font-bold tracking-widest text-muted uppercase">
                Timeline
              </h4>
              {eventsFor(selected.id).length === 0 ? (
                <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
                  No events recorded yet for {selected.name}.
                </p>
              ) : (
                eventsFor(selected.id).map((e) => <TimelineEvent key={e.id} event={e} />)
              )}

              <h4 className="font-display mt-4 mb-4 text-sm font-bold tracking-widest text-muted uppercase">
                Active medications
              </h4>
              {medsFor(selected.id).length === 0 ? (
                <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
                  No active medication right now.
                </p>
              ) : (
                <div className="space-y-2">
                  {medsFor(selected.id).map((m) => (
                    <div
                      key={m.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-canvas/60 px-4 py-3"
                    >
                      <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                        <Pill className="h-4 w-4 text-accent-dark" />
                        {m.name}
                      </span>
                      <span className="text-xs text-muted">
                        {m.dose}, {m.frequency}, {m.daysLeft} days left
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <h4 className="font-display mt-7 mb-4 text-sm font-bold tracking-widest text-muted uppercase">
                Documents
              </h4>
              {docsFor(selected.id).length === 0 ? (
                <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
                  No documents uploaded yet.
                </p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {docsFor(selected.id).map((d) => (
                    <DocumentCard key={d.id} doc={d} />
                  ))}
                </div>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </section>
  );
}

const services: { icon: LucideIcon; title: string; body: string; x: number; y: number }[] = [
  {
    icon: ClipboardList,
    title: "Structured records",
    body: "Every visit, order and report stored as searchable fields with state, author and timestamp, never as loose paper.",
    x: 15,
    y: 20,
  },
  {
    icon: Mic,
    title: "Dictation to draft",
    body: "The vet speaks, the AI structures. Missing values are flagged for review instead of guessed.",
    x: 85,
    y: 20,
  },
  {
    icon: Activity,
    title: "Care board",
    body: "Confirmed care, owner reported logs and unresolved tasks in one clinic view.",
    x: 5,
    y: 50,
  },
  {
    icon: Smartphone,
    title: "Owner app",
    body: "Today screen, one tap dose logging, pet timeline, report upload and refill requests.",
    x: 95,
    y: 50,
  },
  {
    icon: Search,
    title: "Cited answers",
    body: "Record questions answered in plain language, each answer linked to the entry it came from.",
    x: 15,
    y: 80,
  },
  {
    icon: Lock,
    title: "Access and audit",
    body: "Permissions enforced on every request by role, clinic and household, with a traceable audit log.",
    x: 85,
    y: 80,
  },
];

function ServiceNode({
  service,
  active,
  onClick,
  className = "",
  style,
}: {
  service: (typeof services)[number];
  active: boolean;
  onClick: () => void;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <button
      onClick={onClick}
      style={style}
      className={`group flex flex-col items-center gap-2 ${className}`}
    >
      <span
        className={`flex h-12 w-12 items-center justify-center rounded-full border transition-all duration-300 ${
          active
            ? "scale-110 border-primary bg-primary text-canvas shadow-lg shadow-primary/25"
            : "border-line bg-surface text-muted group-hover:border-primary/60 group-hover:text-primary-dark"
        }`}
      >
        <service.icon className="h-5 w-5" />
      </span>
      <span
        className={`text-xs font-semibold transition-colors ${
          active ? "text-primary-dark" : "text-muted group-hover:text-ink"
        }`}
      >
        {service.title}
      </span>
    </button>
  );
}

function Services() {
  const [active, setActive] = useState(0);
  const service = services[active];

  return (
    <section id="services" className="scroll-mt-20 py-20 md:py-28">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="font-accent text-xl italic text-accent-dark">what we offer</p>
          <h2 className="font-display mt-2 text-3xl font-extrabold text-ink md:text-4xl">
            Everything orbits one record
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-muted">
            Six capabilities, all reading and writing the same verified record. Hover or
            tap any node to see what it does.
          </p>
        </div>

        <div className="relative mx-auto mt-12 hidden aspect-square max-w-xl md:block">
          <svg
            aria-hidden
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full text-line"
          >
            {services.map((s) => (
              <line
                key={s.title}
                x1="50"
                y1="50"
                x2={s.x}
                y2={s.y}
                stroke="currentColor"
                strokeWidth="0.25"
              />
            ))}
          </svg>

          <div className="absolute top-1/2 left-1/2 flex h-40 w-40 -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center gap-1 rounded-full border border-primary/30 bg-primary/10 text-center">
            <PawPrint className="h-7 w-7 text-primary-dark" />
            <p className="font-display px-4 text-sm font-bold text-ink">One shared record</p>
          </div>

          {services.map((s, i) => (
            <ServiceNode
              key={s.title}
              service={s}
              active={i === active}
              onClick={() => setActive(i)}
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${s.x}%`, top: `${s.y}%` }}
            />
          ))}
        </div>

        <div className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-3 md:hidden">
          {services.map((s, i) => (
            <ServiceNode key={s.title} service={s} active={i === active} onClick={() => setActive(i)} />
          ))}
        </div>

        <div className="mx-auto mt-10 max-w-xl">
          <AnimatePresence mode="wait">
            <motion.p
              key={active}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.3 }}
              className="text-center text-sm leading-relaxed text-muted"
            >
              <span className="font-display font-bold text-ink">{service.title}: </span>
              {service.body}
            </motion.p>
          </AnimatePresence>
        </div>
      </div>
    </section>
  );
}

function CountUp({ to, suffix = "" }: { to: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });
  const [val, setVal] = useState(0);

  useEffect(() => {
    if (!inView) return;
    const start = performance.now();
    const duration = 1300;
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      setVal(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, to]);

  return (
    <span ref={ref}>
      {val}
      {suffix}
    </span>
  );
}

const stats = [
  { to: 14, suffix: "", label: "core capabilities across clinic and home", tone: "bg-primary/15" },
  { to: 5, suffix: "", label: "role based workspaces with per request permissions", tone: "bg-surface" },
  { to: 6, suffix: "", label: "record states, every one labelled and audited", tone: "bg-accent/15" },
  { to: 0, suffix: "", label: "clinical decisions ever made by AI", tone: "bg-surface" },
];

function StatsBand() {
  return (
    <section className="grid grid-cols-2 md:grid-cols-4">
      {stats.map((s) => (
        <div key={s.label} className={`${s.tone} px-6 py-10 text-center md:py-14`}>
          <p className="font-display text-4xl font-extrabold text-ink md:text-5xl">
            <CountUp to={s.to} suffix={s.suffix} />
          </p>
          <p className="mx-auto mt-3 max-w-[180px] text-xs leading-relaxed text-muted">{s.label}</p>
        </div>
      ))}
    </section>
  );
}

const clinicPoints = [
  "Patient snapshot before the pet is on the table",
  "Dictation that becomes a reviewable draft",
  "Order validation that blocks incomplete prescriptions",
  "Care board with owner reported logs",
  "Versioned notes and a full audit trail",
];

const ownerPoints = [
  "Today screen with exactly what to give and when",
  "One tap Given or Skipped dose logging",
  "Plain language care cards, no medical jargon",
  "Pet timeline and every document in one place",
  "Refill requests and notes back to the clinic",
];

function Portals() {
  return (
    <section className="py-20 md:py-28">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="font-accent text-xl italic text-accent-dark">two doors, one record</p>
          <h2 className="font-display mt-2 text-3xl font-extrabold text-ink md:text-4xl">
            Built for the clinic and the home
          </h2>
        </div>

        <div className="mt-14 grid gap-6 lg:grid-cols-2">
          <motion.div
            id="for-clinics"
            initial={{ opacity: 0, x: -32 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.55, ease: "easeOut" }}
            className="scroll-mt-24 rounded-2xl border border-primary/25 bg-surface p-8 shadow-xl shadow-black/20"
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/15 text-primary-dark">
              <Stethoscope className="h-6 w-6" />
            </span>
            <h3 className="font-display mt-5 text-2xl font-extrabold text-ink">For clinics and vets</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              A professional workspace where documentation is fast, history is one glance
              away and nothing unverified reaches a record.
            </p>
            <ul className="mt-6 space-y-3">
              {clinicPoints.map((p) => (
                <li key={p} className="flex items-start gap-2.5 text-sm text-muted">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  {p}
                </li>
              ))}
            </ul>
            <Link
              href="/clinic/login"
              className="mt-8 inline-flex items-center gap-2 rounded-full bg-primary px-6 py-3 text-sm font-bold text-canvas transition-all hover:gap-3 hover:bg-primary-dark"
            >
              Open the clinic portal
              <ArrowRight className="h-4 w-4" />
            </Link>
          </motion.div>

          <motion.div
            id="for-owners"
            initial={{ opacity: 0, x: 32 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.55, ease: "easeOut" }}
            className="scroll-mt-24 rounded-2xl border border-accent/25 bg-surface p-8 shadow-xl shadow-black/20"
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/15 text-accent-dark">
              <Smartphone className="h-6 w-6" />
            </span>
            <h3 className="font-display mt-5 text-2xl font-extrabold text-ink">For pet owners</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              A warm, simple companion app. No jargon, no guesswork, just today&apos;s care
              and your pet&apos;s whole story. Try a dose log right here:
            </p>
            <ul className="mt-6 space-y-3">
              {ownerPoints.map((p) => (
                <li key={p} className="flex items-start gap-2.5 text-sm text-muted">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                  {p}
                </li>
              ))}
            </ul>

            <div className="mt-6">
              <DoseCard action={todayActions[2]} />
            </div>

            <Link
              href="/owner/login"
              className="mt-6 inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-sm font-bold text-canvas transition-all hover:gap-3 hover:bg-accent-dark"
            >
              Open the pet portal
              <ArrowRight className="h-4 w-4" />
            </Link>
          </motion.div>
        </div>
      </div>
    </section>
  );
}

function SafetyBanner() {
  return (
    <section className="border-y border-primary/20 bg-primary/10 py-10">
      <div className="mx-auto flex max-w-4xl flex-col items-center gap-4 px-6 text-center">
        <ShieldCheck className="h-8 w-8 text-primary-dark" />
        <p className="font-display text-lg font-bold text-ink md:text-xl">
          AI only drafts, summarizes and retrieves. Every clinical decision is made by the
          veterinarian.
        </p>
        <p className="text-sm text-muted">
          Care schedules come from fixed rules, not models, and every record carries its
          state, author and source.
        </p>
      </div>
    </section>
  );
}

function Contact() {
  const [form, setForm] = useState({ name: "", email: "", message: "" });
  const [errors, setErrors] = useState<{ name?: string; email?: string; message?: string }>({});
  const [sent, setSent] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (form.name.trim().length < 2) next.name = "Please tell us your name.";
    if (!form.email.includes("@")) next.email = "That email does not look right.";
    if (form.message.trim().length < 10) next.message = "A little more detail helps us reply well.";
    setErrors(next);
    if (Object.keys(next).length === 0) setSent(true);
  };

  const field =
    "w-full rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink outline-none transition-colors placeholder:text-muted/60 focus:border-primary focus:ring-2 focus:ring-primary/20";

  return (
    <section id="contact" className="scroll-mt-20 bg-abyss py-20 md:py-28">
      <div className="mx-auto grid max-w-6xl gap-12 px-6 lg:grid-cols-[0.9fr_1.1fr]">
        <div>
          <p className="font-accent text-xl italic text-accent-dark">say hello</p>
          <h2 className="font-display mt-2 text-3xl font-extrabold text-ink md:text-4xl">
            Bring your clinic on board
          </h2>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-muted">
            Tell us about your clinic or your pet and we will walk you through the
            platform, the safety model and the rollout plan.
          </p>
          <div className="mt-8 space-y-4 text-sm text-muted">
            <p className="flex items-center gap-3">
              <Mail className="h-4 w-4 text-primary-dark" />
              hello@pawfolio.ai
            </p>
            <p className="flex items-center gap-3">
              <Phone className="h-4 w-4 text-primary-dark" />
              +92 21 111 729 729
            </p>
            <p className="flex items-center gap-3">
              <MapPin className="h-4 w-4 text-primary-dark" />
              Lahore, Pakistan
            </p>
          </div>
        </div>

        <AnimatePresence mode="wait">
          {sent ? (
            <motion.div
              key="sent"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex flex-col items-center justify-center rounded-2xl border border-success/30 bg-success/10 p-10 text-center"
            >
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-success/20 text-green-300">
                <Check className="h-7 w-7" />
              </span>
              <p className="font-display mt-4 text-xl font-bold text-ink">Message received</p>
              <p className="mt-2 max-w-sm text-sm text-muted">
                Thanks {form.name.split(" ")[0]}. We reply to every message within two
                working days.
              </p>
            </motion.div>
          ) : (
            <motion.form
              key="form"
              onSubmit={submit}
              noValidate
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
              className="space-y-4 rounded-2xl border border-line bg-canvas/60 p-6 md:p-8"
            >
              <div>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Your name"
                  className={field}
                />
                {errors.name && <p className="mt-1.5 text-xs font-semibold text-red-400">{errors.name}</p>}
              </div>
              <div>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  placeholder="Email address"
                  className={field}
                />
                {errors.email && <p className="mt-1.5 text-xs font-semibold text-red-400">{errors.email}</p>}
              </div>
              <div>
                <textarea
                  rows={5}
                  value={form.message}
                  onChange={(e) => setForm({ ...form, message: e.target.value })}
                  placeholder="Tell us about your clinic or your pet"
                  className={`${field} resize-none`}
                />
                {errors.message && (
                  <p className="mt-1.5 text-xs font-semibold text-red-400">{errors.message}</p>
                )}
              </div>
              <motion.button
                whileTap={{ scale: 0.97 }}
                type="submit"
                className="w-full rounded-full bg-primary py-3 text-sm font-bold text-canvas transition-colors hover:bg-primary-dark"
              >
                Send message
              </motion.button>
            </motion.form>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-line bg-abyss py-14">
      <div className="mx-auto max-w-6xl px-6">
        <div className="grid gap-10 md:grid-cols-[1.2fr_0.8fr_1fr]">
          <div>
            <Link href="#top" className="flex items-center gap-2.5">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-canvas">
                <PawPrint className="h-5 w-5" />
              </span>
              <span className="font-display text-lg font-extrabold text-ink">
                Pawfolio <span className="text-primary">AI</span>
              </span>
            </Link>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-muted">
              One connected record between the clinic and the home. AI drafts, the
              veterinarian decides, and every confirmed order becomes a clear care plan.
            </p>
          </div>

          <div>
            <p className="font-display text-sm font-bold tracking-widest text-ink uppercase">
              Explore
            </p>
            <ul className="mt-4 space-y-2.5">
              {navLinks.map((l) => (
                <li key={l.href}>
                  <a href={l.href} className="text-sm text-muted transition-colors hover:text-ink">
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className="font-display text-sm font-bold tracking-widest text-ink uppercase">
              Principles
            </p>
            <ul className="mt-4 space-y-2.5 text-sm text-muted">
              <li>AI drafts, the veterinarian decides</li>
              <li>Care schedules come from fixed rules</li>
              <li>Every record labelled, versioned and audited</li>
              <li>Access checked on every request, by role</li>
            </ul>
          </div>
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t border-line pt-6 md:flex-row md:items-center md:justify-between">
          <p className="text-xs text-muted">© 2026 Pawfolio AI. All rights reserved.</p>
          <p className="max-w-md text-xs text-muted md:text-right">
            Decision support software, not a medical device. It does not diagnose,
            prescribe or recommend doses.
          </p>
        </div>
      </div>
    </footer>
  );
}

export default function Landing() {
  return (
    <div className="bg-canvas">
      <Navbar />
      <main>
        <Hero />
        <HowItWorks />
        <PatientGallery />
        <Services />
        <StatsBand />
        <Portals />
        <SafetyBanner />
        <Contact />
      </main>
      <Footer />
    </div>
  );
}