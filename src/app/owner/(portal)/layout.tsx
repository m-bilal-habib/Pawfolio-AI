"use client";

import { FileText, History, Home, LogOut, PawPrint, Pill } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { EmptyState, OwnerRoleBadge } from "@/components/ui";
import { useAuth } from "@/lib/auth";

const tabs = [
  { href: "/owner/dashboard", label: "Today", icon: Home, match: "/owner/dashboard" },
  { href: "/owner/medications", label: "Medications", icon: Pill, match: "/owner/medications" },
  { href: "/owner/pets/buddy", label: "Timeline", icon: History, match: "/owner/pets" },
  { href: "/owner/documents", label: "Documents", icon: FileText, match: "/owner/documents" },
];

export default function OwnerPortalLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { ownerSignedIn, signOutOwner } = useAuth();

  if (!ownerSignedIn) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-canvas px-4">
        <div className="w-full max-w-md">
          <EmptyState
            icon={Home}
            title="Sign in to the pet portal"
            body="Use the pet owner sign-in page to open your home care dashboard."
          />
        </div>
        <Link
          href="/owner/login"
          className="rounded-full bg-accent px-6 py-3 text-sm font-bold text-canvas transition-colors hover:bg-accent-dark"
        >
          Go to Pet Owner Login
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-canvas pb-24">
      <header className="sticky top-0 z-40 border-b border-line bg-surface/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between px-4">
          <Link href="/owner/dashboard" className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-canvas">
              <PawPrint className="h-5 w-5" />
            </span>
            <span className="font-display text-lg font-extrabold text-ink">Pet Portal</span>
          </Link>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className="text-sm font-semibold text-ink">Ali Raza</p>
              <OwnerRoleBadge />
            </div>
            <button
              onClick={signOutOwner}
              aria-label="Sign out"
              className="flex h-9 w-9 items-center justify-center rounded-full border border-line text-muted transition-colors hover:border-error/40 hover:text-red-400"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-8">{children}</main>

      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur-md">
        <div className="mx-auto grid max-w-3xl grid-cols-4">
          {tabs.map((t) => {
            const active = pathname.startsWith(t.match);
            return (
              <Link
                key={t.href}
                href={t.href}
                className={`flex flex-col items-center gap-1 py-3 text-xs font-semibold transition-colors ${
                  active ? "text-accent-dark" : "text-muted hover:text-ink"
                }`}
              >
                <t.icon className="h-5 w-5" />
                {t.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}