"use client";

import { motion } from "framer-motion";
import { PawPrint, Stethoscope, Wand2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAuth } from "@/lib/auth";
import type { Role } from "@/lib/data";
import { PageFade } from "@/components/ui";

const roles: Role[] = ["Veterinarian", "Receptionist", "Assistant", "Admin"];

const demoAccounts: Record<Role, { email: string; password: string }> = {
  Veterinarian: { email: "dr.ahmed@pawfolio.ai", password: "clinical-demo-1" },
  Receptionist: { email: "hina@pawfolio.ai", password: "clinical-demo-1" },
  Assistant: { email: "bilal@pawfolio.ai", password: "clinical-demo-1" },
  Admin: { email: "sana@pawfolio.ai", password: "clinical-demo-1" },
};

export default function ClinicLogin() {
  const router = useRouter();
  const { signInClinic } = useAuth();
  const [role, setRole] = useState<Role>("Veterinarian");
  const [email, setEmail] = useState(demoAccounts.Veterinarian.email);
  const [password, setPassword] = useState(demoAccounts.Veterinarian.password);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});

  const enter = (r: Role) => {
    signInClinic(r);
    router.push("/clinic/dashboard");
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
    <div className="flex min-h-screen items-center justify-center bg-primary/5 px-4 py-16">
      <PageFade className="w-full max-w-md">
        <motion.div
          initial={{ opacity: 0, y: 24, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="rounded-2xl border border-line bg-surface p-8 shadow-xl shadow-primary/10"
        >
          <motion.button
            whileTap={{ scale: 0.98 }}
            onClick={() => enter(role)}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-primary/40 bg-primary/10 py-3 text-sm font-bold text-primary-dark transition-all duration-300 hover:-translate-y-0.5 hover:border-primary hover:bg-primary hover:text-canvas"
          >
            <Wand2 className="h-4 w-4" />
            One-click demo login as {role}
          </motion.button>
          <p className="mt-2 text-center text-xs text-muted">
            Fake auth, no backend. Uses the demo account for the selected role.
          </p>

          <div className="my-6 flex items-center gap-3">
            <span className="h-px flex-1 bg-line" />
            <span className="text-xs font-semibold uppercase tracking-widest text-muted">or fill the form</span>
            <span className="h-px flex-1 bg-line" />
          </div>

          <div className="flex items-center gap-2">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-canvas">
              <PawPrint className="h-5 w-5" />
            </span>
            <span className="font-display text-xl font-extrabold text-ink">Pawfolio AI</span>
          </div>
          <h1 className="mt-6 font-display text-2xl font-extrabold text-ink">Clinic sign in</h1>
          <p className="mt-1 text-sm text-muted">Access your role-based workspace.</p>

          <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
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