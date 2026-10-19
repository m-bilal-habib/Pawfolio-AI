"use client";

import { motion } from "framer-motion";
import { Home, PawPrint, Wand2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { PageFade } from "@/components/ui";

export default function OwnerLogin() {
  const router = useRouter();
  const { signInOwner } = useAuth();
  const [email, setEmail] = useState("ali.raza@example.com");
  const [password, setPassword] = useState("home-demo-123");
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});

  const enter = () => {
    signInOwner();
    router.push("/owner/dashboard");
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const next: { email?: string; password?: string } = {};
    if (!email.includes("@")) next.email = "Enter a valid email address.";
    if (password.length < 6) next.password = "Password must be at least 6 characters.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    enter();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-accent/5 px-4 py-16">
      <PageFade className="w-full max-w-md">
        <motion.div
          initial={{ opacity: 0, y: 24, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="rounded-2xl border border-line bg-surface p-8 shadow-xl shadow-accent/10"
        >
          <motion.button
            whileTap={{ scale: 0.98 }}
            onClick={enter}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-accent/40 bg-accent/10 py-3 text-sm font-bold text-accent-dark transition-all duration-300 hover:-translate-y-0.5 hover:border-accent hover:bg-accent hover:text-canvas"
          >
            <Wand2 className="h-4 w-4" />
            One-click demo login as pet owner
          </motion.button>
          <p className="mt-2 text-center text-xs text-muted">
            Fake auth, no backend. Opens the owner dashboard immediately.
          </p>

          <div className="my-6 flex items-center gap-3">
            <span className="h-px flex-1 bg-line" />
            <span className="text-xs font-semibold uppercase tracking-widest text-muted">or fill the form</span>
            <span className="h-px flex-1 bg-line" />
          </div>

          <div className="flex items-center gap-2">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-canvas">
              <PawPrint className="h-5 w-5" />
            </span>
            <span className="font-display text-xl font-extrabold text-ink">Pawfolio AI</span>
          </div>
          <h1 className="mt-6 font-display text-2xl font-extrabold text-ink">Pet portal sign in</h1>
          <p className="mt-1 text-sm text-muted">Your pet&apos;s care plan, reminders and records in one place.</p>

          <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
            <div>
              <label className="text-sm font-semibold text-ink" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="mt-1.5 w-full rounded-lg border border-line bg-canvas px-3.5 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-muted/60 focus:border-accent focus:ring-2 focus:ring-accent/20"
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
                className="mt-1.5 w-full rounded-lg border border-line bg-canvas px-3.5 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-muted/60 focus:border-accent focus:ring-2 focus:ring-accent/20"
              />
              {errors.password && <p className="mt-1 text-xs font-medium text-red-400">{errors.password}</p>}
            </div>

            <motion.button
              whileTap={{ scale: 0.98 }}
              type="submit"
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-3 text-sm font-bold text-canvas transition-colors hover:bg-accent-dark"
            >
              <Home className="h-4 w-4" />
              Sign In to Pet Portal
            </motion.button>
          </form>

          <p className="mt-5 text-center text-sm text-muted">
            Are you clinic staff?{" "}
            <Link href="/clinic/login" className="font-semibold text-primary-dark hover:underline">
              Go to the Clinic Portal
            </Link>
          </p>
        </motion.div>
      </PageFade>
    </div>
  );
}