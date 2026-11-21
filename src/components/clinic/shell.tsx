"use client";

import { motion } from "framer-motion";
import {
  Activity,
  ArrowLeftRight,
  CalendarDays,
  Home,
  Lock,
  LogOut,
  Mic,
  PawPrint,
  Plus,
  Settings,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { roleDisplayName, useAuth } from "@/lib/auth";
import type { Role } from "@/lib/data";
import { RoleBadge } from "../ui";

type NavItem = {
  href: string;
  label: string;
  badge?: string;
  icon: LucideIcon;
  roles: Role[];
  lockedFor?: Role[];
};

const allRoles: Role[] = ["Veterinarian", "Receptionist", "Assistant", "Admin"];

const navItems: NavItem[] = [
  { href: "/clinic/dashboard", label: "My Day", icon: CalendarDays, roles: allRoles },
  {
    href: "/clinic/vox-soap",
    label: "VoxSOAP Scribe",
    badge: "AI",
    icon: Mic,
    roles: ["Veterinarian", "Assistant", "Admin"],
    lockedFor: ["Receptionist"],
  },
  {
    href: "/clinic/patients",
    label: "Patients",
    icon: Users,
    roles: ["Veterinarian", "Receptionist", "Admin"],
  },
  { href: "/clinic/care-board", label: "Care Board", icon: Activity, roles: ["Veterinarian", "Admin"] },
  { href: "/clinic/admin", label: "Admin", icon: Settings, roles: ["Admin"] },
];

export function ClinicSidebar({
  role,
  mobileOpen = false,
  onMobileClose,
}: {
  role: Role;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}) {
  const pathname = usePathname();
  const { signOutClinic } = useAuth();
  const canDictate = role !== "Receptionist";
  const items = navItems.filter((i) => i.roles.includes(role) || i.lockedFor?.includes(role));

  const sidebarBody = (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-5 py-5">
        <Link href="/" onClick={onMobileClose} className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-canvas">
            <PawPrint className="h-5 w-5" />
          </span>
          <span className="font-display text-lg font-extrabold text-ink">Pawfolio AI</span>
        </Link>
        {onMobileClose && (
          <button
            type="button"
            onClick={onMobileClose}
            aria-label="Close navigation menu"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-line text-muted hover:text-ink lg:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {canDictate && (
        <div className="px-3 pb-3">
          <Link
            href="/clinic/vox-soap?action=ml-assist"
            onClick={onMobileClose}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-3 py-2.5 text-sm font-bold text-canvas shadow-sm shadow-primary/25 transition-colors hover:bg-primary-dark"
          >
            <Plus className="h-4 w-4" />
            New SOAP Note
          </Link>
        </div>
      )}

      <nav aria-label="Clinic navigation" className="mt-1 flex-1 space-y-1 overflow-y-auto px-3">
        {items.map((item) => {
          const active = pathname.startsWith(item.href);
          const locked = Boolean(item.lockedFor?.includes(role) && !item.roles.includes(role));

          if (locked) {
            return (
              <div
                key={item.href}
                title="Clinical staff only — receptionists cannot initiate SOAP dictation (FR-6)"
                className="flex cursor-not-allowed items-center justify-between rounded-lg px-3 py-2.5 text-sm font-semibold text-muted/60"
              >
                <span className="flex items-center gap-3">
                  <item.icon className="h-4.5 w-4.5" />
                  {item.label}
                </span>
                <span className="inline-flex items-center gap-1 rounded bg-surface px-1.5 py-0.5 text-[10px] font-semibold text-muted">
                  <Lock className="h-3 w-3" />
                  Vet/Asst
                </span>
              </div>
            );
          }

          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onMobileClose}
              className={`flex items-center justify-between rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors ${
                active
                  ? "bg-primary text-canvas shadow-sm shadow-primary/30"
                  : "text-muted hover:bg-line/60 hover:text-ink"
              }`}
            >
              <span className="flex items-center gap-3">
                <item.icon className="h-4.5 w-4.5" />
                {item.label}
              </span>
              {item.badge && (
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                    active ? "bg-canvas/20 text-canvas" : "bg-primary/15 text-primary-dark"
                  }`}
                >
                  {item.badge}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="space-y-2 border-t border-line p-4">
        <div className="grid grid-cols-2 gap-1.5 pb-1">
          <Link
            href="/"
            onClick={onMobileClose}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1.5 text-xs font-semibold text-muted transition-colors hover:border-primary/40 hover:text-ink"
          >
            <Home className="h-3.5 w-3.5" />
            Home
          </Link>
          <Link
            href="/owner/login"
            onClick={onMobileClose}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1.5 text-xs font-semibold text-muted transition-colors hover:border-accent/40 hover:text-accent-dark"
          >
            <ArrowLeftRight className="h-3.5 w-3.5" />
            Pet Portal
          </Link>
        </div>

        <div className="flex items-center gap-3 pt-1">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 font-display text-sm font-extrabold text-primary-dark">
            {roleDisplayName[role].charAt(0)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">{roleDisplayName[role]}</p>
            <RoleBadge role={role} />
          </div>
        </div>
        <button
          onClick={signOutClinic}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-line bg-surface py-2 text-sm font-semibold text-muted transition-colors hover:border-error/40 hover:text-red-400"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop persistent sidebar */}
      <motion.aside
        initial={{ x: -240 }}
        animate={{ x: 0 }}
        transition={{ duration: 0.45, ease: "easeOut" }}
        className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-line bg-sidebar lg:flex"
      >
        {sidebarBody}
      </motion.aside>

      {/* Mobile / tablet slide-over drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div
            onClick={onMobileClose}
            className="fixed inset-0 bg-black/70 backdrop-blur-xs"
            aria-hidden="true"
          />
          <aside className="relative z-10 flex w-64 max-w-[80vw] flex-col border-r border-line bg-sidebar shadow-2xl">
            {sidebarBody}
          </aside>
        </div>
      )}
    </>
  );
}