"use client";

import { Stethoscope } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ClinicSidebar } from "@/components/clinic/shell";
import { EmptyState } from "@/components/ui";
import { useAuth } from "@/lib/auth";

export default function ClinicPortalLayout({ children }: { children: ReactNode }) {
  const { clinicRole } = useAuth();

  if (!clinicRole) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-canvas px-4">
        <div className="w-full max-w-md">
          <EmptyState
            icon={Stethoscope}
            title="Sign in to the clinic portal"
            body="Pick your role on the clinic sign-in page to open your workspace."
          />
        </div>
        <Link
          href="/clinic/login"
          className="rounded-full bg-primary px-6 py-3 text-sm font-bold text-canvas transition-colors hover:bg-primary-dark"
        >
          Go to Clinic Login
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-canvas">
      <ClinicSidebar role={clinicRole} />
      <main className="ml-60 px-6 py-8 lg:px-10">{children}</main>
    </div>
  );
}