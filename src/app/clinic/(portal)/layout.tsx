"use client";

import { ChevronRight, Menu, Mic, Stethoscope } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { ClinicSidebar } from "@/components/clinic/shell";
import { EmptyState } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { petById } from "@/lib/data";

function buildBreadcrumbs(pathname: string): Array<{ label: string; href: string }> {
  const crumbs: Array<{ label: string; href: string }> = [
    { label: "Clinic", href: "/clinic/dashboard" },
  ];
  if (pathname.startsWith("/clinic/vox-soap")) {
    crumbs.push({ label: "VoxSOAP AI Scribe", href: "/clinic/vox-soap" });
  } else if (pathname.startsWith("/clinic/patients/")) {
    const id = pathname.split("/")[3] ?? "";
    const pet = petById(id);
    crumbs.push({ label: "Patients", href: "/clinic/patients" });
    crumbs.push({ label: pet ? pet.name : id, href: pathname });
  } else if (pathname.startsWith("/clinic/patients")) {
    crumbs.push({ label: "Patients", href: "/clinic/patients" });
  } else if (pathname.startsWith("/clinic/care-board")) {
    crumbs.push({ label: "Care Board", href: "/clinic/care-board" });
  } else if (pathname.startsWith("/clinic/admin")) {
    crumbs.push({ label: "Administration", href: "/clinic/admin" });
  } else {
    crumbs.push({ label: "My Day", href: "/clinic/dashboard" });
  }
  return crumbs;
}

export default function ClinicPortalLayout({ children }: { children: ReactNode }) {
  const { clinicRole } = useAuth();
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  if (!clinicRole) {
    const nextUrl = pathname.startsWith("/clinic") ? pathname : "/clinic/dashboard";
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-canvas px-4">
        <div className="w-full max-w-md">
          <EmptyState
            icon={Stethoscope}
            title="Sign in to the clinic portal"
            body="Pick your clinic role to open your workspace or VoxSOAP AI Scribe."
          />
        </div>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            href={`/clinic/login?next=${encodeURIComponent(nextUrl)}`}
            className="rounded-full bg-primary px-6 py-3 text-sm font-bold text-canvas transition-colors hover:bg-primary-dark"
          >
            Go to Clinic Login
          </Link>
          <Link
            href="/"
            className="rounded-full border border-line px-5 py-3 text-sm font-semibold text-muted transition-colors hover:border-primary/40 hover:text-ink"
          >
            ← Back to Home
          </Link>
        </div>
      </div>
    );
  }

  const crumbs = buildBreadcrumbs(pathname);
  const onVoxSoap = pathname.startsWith("/clinic/vox-soap");
  const canDictate = clinicRole !== "Receptionist";

  return (
    <div className="min-h-screen bg-canvas">
      <ClinicSidebar
        role={clinicRole}
        mobileOpen={mobileMenuOpen}
        onMobileClose={() => setMobileMenuOpen(false)}
      />
      <div className="lg:ml-60">
        <div className="sticky top-0 z-30 border-b border-line bg-canvas/90 px-4 py-3 backdrop-blur-md sm:px-6 lg:px-10">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => setMobileMenuOpen(true)}
                aria-label="Open clinic navigation"
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-surface text-ink lg:hidden"
              >
                <Menu className="h-4.5 w-4.5" />
              </button>
              <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-xs sm:text-sm">
                {crumbs.map((c, idx) => {
                  const isLast = idx === crumbs.length - 1;
                  return (
                    <span key={`${c.href}-${idx}`} className="flex items-center gap-1.5">
                      {idx > 0 && <ChevronRight className="h-3.5 w-3.5 text-muted/60" />}
                      {isLast ? (
                        <span className="font-bold text-ink">{c.label}</span>
                      ) : (
                        <Link href={c.href} className="font-medium text-muted transition-colors hover:text-primary-dark">
                          {c.label}
                        </Link>
                      )}
                    </span>
                  );
                })}
              </nav>
            </div>

            {!onVoxSoap && canDictate && (
              <Link
                href="/clinic/vox-soap"
                className="inline-flex items-center gap-1.5 rounded-full border border-primary/50 bg-primary/10 px-3.5 py-1.5 text-xs font-bold text-primary-dark transition-colors hover:bg-primary hover:text-canvas"
              >
                <Mic className="h-3.5 w-3.5" />
                Open VoxSOAP Scribe
              </Link>
            )}
          </div>
        </div>

        <main className={onVoxSoap ? "px-0 py-0" : "px-4 py-6 sm:px-6 lg:px-10 lg:py-8"}>{children}</main>
      </div>
    </div>
  );
}