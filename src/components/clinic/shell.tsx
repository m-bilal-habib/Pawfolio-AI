"use client";

import { motion } from "framer-motion";
import { Activity, CalendarDays, LogOut, PawPrint, Settings, Users, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { roleDisplayName, useAuth } from "@/lib/auth";
import type { Role } from "@/lib/data";
import { RoleBadge } from "../ui";

type NavItem = { href: string; label: string; icon: LucideIcon; roles: Role[] };

const allRoles: Role[] = ["Veterinarian", "Receptionist", "Assistant", "Admin"];

const navItems: NavItem[] = [
  { href: "/clinic/dashboard", label: "My Day", icon: CalendarDays, roles: allRoles },
  {
    href: "/clinic/patients",
    label: "Patients",
    icon: Users,
    roles: ["Veterinarian", "Receptionist", "Admin"],
  },
  { href: "/clinic/care-board", label: "Care Board", icon: Activity, roles: ["Veterinarian", "Admin"] },
  { href: "/clinic/admin", label: "Admin", icon: Settings, roles: ["Admin"] },
];

export function ClinicSidebar({ role }: { role: Role }) {
  const pathname = usePathname();
  const { signOutClinic } = useAuth();
  const items = navItems.filter((i) => i.roles.includes(role));

  return (
    <motion.aside
      initial={{ x: -240 }}
      animate={{ x: 0 }}
      transition={{ duration: 0.45, ease: "easeOut" }}
      className="fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-line bg-sidebar"
    >
      <Link href="/" className="flex items-center gap-2 px-5 py-5">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-canvas">
          <PawPrint className="h-5 w-5" />
        </span>
        <span className="font-display text-lg font-extrabold text-ink">Pawfolio AI</span>
      </Link>

      <nav className="mt-2 flex-1 space-y-1 px-3">
        {items.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors ${
                active ? "bg-primary text-canvas shadow-sm shadow-primary/30" : "text-muted hover:bg-line/60 hover:text-ink"
              }`}
            >
              <item.icon className="h-4.5 w-4.5" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-line p-4">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 font-display text-sm font-extrabold text-primary-dark">
            {roleDisplayName[role].charAt(0)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">{roleDisplayName[role]}</p>
            <RoleBadge role={role} />
          </div>
        </div>
        <button
          onClick={signOutClinic}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-line bg-surface py-2 text-sm font-semibold text-muted transition-colors hover:border-error/40 hover:text-red-400"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </div>
    </motion.aside>
  );
}