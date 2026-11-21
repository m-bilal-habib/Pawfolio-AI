"use client";

import { motion } from "framer-motion";
import { ArrowLeft, Mic, PawPrint, Stethoscope, Wand2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useAuth } from "@/lib/auth";
import type { Role } from "@/lib/data";
import { PageFade } from "@/components/ui";

const roles: Role[] = ["Veterinarian", "Receptionist", "Assistant", "Admin"];

const demoAccounts: Record<Role, { email: string; password: string; hint: string }> = {
  Veterinarian: {
    email: "dr.ahmed@pawfolio.ai",
    password: "clinical-demo-1",
    hint: "Full VoxSOAP dictation, SOAP editing, prescription sign-off & care card publishing.",
  },
  Receptionist: {
    email: "hina@pawfolio.ai",
    password: "clinical-demo-1",
    hint: "Scheduling, registration queue & patient lookup (clinical dictation restricted per FR-6).",
  },
  Assistant: {
    email: "bilal@pawfolio.ai",
    password: "clinical-demo-1",
    hint: "Intake tasks, VoxSOAP audio capture & draft preparation (vet confirms final note).",
  },
  Admin: {
    email: "sana@pawfolio.ai",
    password: "clinical-demo-1",
    hint: "Clinic settings, staff management, care board & VoxSOAP access.",
  },
};

function safeClinicTarget(nextParam: string | null): string {
  if (nextParam && nextParam.startsWith("/clinic") && !nextParam.startsWith("/clinic/login")) {
    return nextParam;
  }
  return "/clinic/dashboard";
}

function ClinicLoginInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextTarget = safeClinicTarget(searchParams.get("next"));
  const { signInClinic } = useAuth();
  const [role, setRole] = useState<Role>("Veterinarian");
  const [email, setEmail] = useState(demoAccounts.Veterinarian.email);
  const [password, setPassword] = useState(demoAccounts.Veterinarian.password);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});

  const enter = (r: Role, destination = nextTarget) => {
    signInClinic(r);
    router.push(destination);
  };

  const switchRole = (r: Role) => {
    setRole(r);
    setEmail(demoAccounts[r].email);
    setPassword(demoAccounts[r].password);
    setErrors({});
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const next: { email?: string; password?: string } = {};
    if (!email.includes("@")) next.email = "Enter a valid work email address.";
    if (password.length < 6) next.password = "Password must be at least 6 characters.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    enter(role);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-primary/5 px-4 py-12">
      <PageFade className="w-full max-w-md">
        <div className="mb-4 flex items-center justify-between text-xs font-semibold">
          <Link href="/" className="inline-flex items-center gap-1.5 text-muted transition-colors hover:text-ink">
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to Pawfolio Home
          </Link>
          <Link href="/owner/login" className="text-accent-dark hover:underline">
            Pet Owner Portal →
          </Link>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 24, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="rounded-2xl border border-line bg-surface p-8 shadow-xl shadow-primary/10"
        >
          <div className="space-y-2.5">
            <motion.button
              whileTap={{ scale: 0.98 }}
              onClick={() => enter("Veterinarian", "/clinic/vox-soap")}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-3 text-sm font-bold text-canvas shadow-md shadow-primary/20 transition-all duration-300 hover:-translate-y-0.5 hover:bg-primary-dark"
            >
              <Mic className="h-4 w-4" />
              Try VoxSOAP AI Scribe (Vet Demo)
            </motion.button>
            <motion.button
              whileTap={{ scale: 0.98 }}
              onClick={() => enter(role)}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-primary/40 bg-primary/10 py-2.5 text-sm font-bold text-primary-dark transition-all duration-300 hover:border-primary hover:bg-primary/20"
            >
              <Wand2 className="h-4 w-4" />
              One-click demo login as {role}
            </motion.button>
          </div>
          <p className="mt-2 text-center text-xs text-muted">
            Demo sign-in — {nextTarget !== "/clinic/dashboard" ? `opens ${nextTarget}` : "opens your clinic workspace"}.
          </p>

          <div className="my-6 flex items-center gap-3">
            <span className="h-px flex-1 bg-line" />
            <span className="text-xs font-semibold uppercase tracking-widest text-muted">or choose role &amp; sign in</span>
            <span className="h-px flex-1 bg-line" />
          </div>

          <div className="flex items-center gap-2">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-canvas">
              <PawPrint className="h-5 w-5" />
            </span>
            <span className="font-display text-xl font-extrabold text-ink">Pawfolio AI</span>
          </div>
          <h1 className="mt-5 font-display text-2xl font-extrabold text-ink">Clinic sign in</h1>
          <p className="mt-1 text-sm text-muted">Access your role-based veterinary workspace.</p>

          <form onSubmit={submit} className="mt-5 space-y-4" noValidate>
            <div>
              <label className="text-sm font-semibold text-ink" htmlFor="role">
                Role
              </label>
              <div id="role" className="mt-2 grid grid-cols-2 gap-2">
                {roles.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => switchRole(r)}
                    className={`rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
                      role === r
                        ? "border-primary bg-primary text-canvas"
                        : "border-line bg-surface text-muted hover:border-primary/50 hover:text-primary-dark"
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
              <p className="mt-2 rounded-lg bg-sidebar px-3 py-2 text-xs leading-relaxed text-muted">
                <strong className="text-ink">{role}:</strong> {demoAccounts[role].hint}
              </p>
            </div>

            <div>
              <label className="text-sm font-semibold text-ink" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@clinic.com"
                className="mt-1.5 w-full rounded-lg border border-line bg-canvas px-3.5 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-muted/60 focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
              {errors.email && <p className="mt-1 text-xs font-medium text-red-400">{errors.email}</p>}
            </div>

            <div>
              <label className="text-sm font-semibold text-ink" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your password"
                className="mt-1.5 w-full rounded-lg border border-line bg-canvas px-3.5 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-muted/60 focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
              {errors.password && <p className="mt-1 text-xs font-medium text-red-400">{errors.password}</p>}
            </div>

            <motion.button
              whileTap={{ scale: 0.98 }}
              type="submit"
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-3 text-sm font-bold text-canvas transition-colors hover:bg-primary-dark"
            >
              <Stethoscope className="h-4 w-4" />
              Sign In to Clinic Portal
            </motion.button>
          </form>

          <p className="mt-5 text-center text-sm text-muted">
            Are you a pet owner?{" "}
            <Link href="/owner/login" className="font-semibold text-accent-dark hover:underline">
              Go to the Pet Portal
            </Link>
          </p>
        </motion.div>
      </PageFade>
    </div>
  );
}

export default function ClinicLogin() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-canvas" />}>
      <ClinicLoginInner />
    </Suspense>
  );
}