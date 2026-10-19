"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Role } from "./data";

type AuthState = {
  clinicRole: Role | null;
  ownerSignedIn: boolean;
  signInClinic: (role: Role) => void;
  signOutClinic: () => void;
  signInOwner: () => void;
  signOutOwner: () => void;
};

const AuthContext = createContext<AuthState | null>(null);

const ROLE_KEY = "pawfolio.clinicRole";
const OWNER_KEY = "pawfolio.ownerSignedIn";
const roles: Role[] = ["Veterinarian", "Receptionist", "Assistant", "Admin"];

function readRole(): Role | null {
  if (typeof window === "undefined") return null;
  const saved = window.localStorage.getItem(ROLE_KEY);
  return roles.includes(saved as Role) ? (saved as Role) : null;
}

function readOwner(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(OWNER_KEY) === "1";
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [clinicRole, setClinicRole] = useState<Role | null>(() => readRole());
  const [ownerSignedIn, setOwnerSignedIn] = useState<boolean>(() => readOwner());

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (clinicRole) window.localStorage.setItem(ROLE_KEY, clinicRole);
    else window.localStorage.removeItem(ROLE_KEY);
  }, [clinicRole]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (ownerSignedIn) window.localStorage.setItem(OWNER_KEY, "1");
    else window.localStorage.removeItem(OWNER_KEY);
  }, [ownerSignedIn]);

  const value = useMemo<AuthState>(
    () => ({
      clinicRole,
      ownerSignedIn,
      signInClinic: (role) => setClinicRole(role),
      signOutClinic: () => setClinicRole(null),
      signInOwner: () => setOwnerSignedIn(true),
      signOutOwner: () => setOwnerSignedIn(false),
    }),
    [clinicRole, ownerSignedIn]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

export const roleDisplayName: Record<Role, string> = {
  Veterinarian: "Dr. Ahmed",
  Receptionist: "Hina Asif",
  Assistant: "Bilal Khan",
  Admin: "Sana Malik",
};