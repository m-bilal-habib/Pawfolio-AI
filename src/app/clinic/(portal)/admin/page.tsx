"use client";

import { motion } from "framer-motion";
import { ShieldCheck, UserPlus } from "lucide-react";
import { RoleBadge, StatusBadge, staggerChild, staggerParent } from "@/components/ui";
import { staff } from "@/lib/data";

const settings = [
  { title: "Documentation templates", body: "Visit note and care card templates shared by the whole clinic." },
  { title: "Invitation links", body: "Owner invitations with contact verification before household claiming." },
  { title: "Session policy", body: "Sessions are revocable and staff accounts support multi-factor sign-in." },
];

export default function AdminPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-extrabold text-ink">Administration</h1>
          <p className="mt-1 text-sm text-muted">Staff accounts, roles and clinic settings.</p>
        </div>
        <button className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-canvas transition-colors hover:bg-primary-dark">
          <UserPlus className="h-4 w-4" />
          Invite staff member
        </button>
      </div>

      <motion.div
        variants={staggerParent}
        initial="hidden"
        animate="show"
        className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm"
      >
        <table className="w-full text-left text-sm">
          <thead className="bg-sidebar text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-5 py-3 font-semibold">Name</th>
              <th className="px-5 py-3 font-semibold">Role</th>
              <th className="hidden px-5 py-3 font-semibold md:table-cell">Email</th>
              <th className="px-5 py-3 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {staff.map((s) => (
              <motion.tr key={s.id} variants={staggerChild} className="border-t border-line">
                <td className="px-5 py-3.5 font-semibold text-ink">{s.name}</td>
                <td className="px-5 py-3.5">
                  <RoleBadge role={s.role} />
                </td>
                <td className="hidden px-5 py-3.5 text-muted md:table-cell">{s.email}</td>
                <td className="px-5 py-3.5">
                  <StatusBadge status={s.status === "Active" ? "Verified" : "Draft"} />
                </td>
              </motion.tr>
            ))}
          </tbody>
        </table>
      </motion.div>

      <div className="grid gap-4 md:grid-cols-3">
        {settings.map((s, i) => (
          <motion.div
            key={s.title}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 + i * 0.06, duration: 0.4, ease: "easeOut" }}
            className="rounded-2xl border border-line bg-surface p-5 shadow-sm"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary-dark">
              <ShieldCheck className="h-5 w-5" />
            </span>
            <p className="mt-3 font-semibold text-ink">{s.title}</p>
            <p className="mt-1 text-sm leading-relaxed text-muted">{s.body}</p>
          </motion.div>
        ))}
      </div>
    </div>
  );
}