"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";

/**
 * The signed-in principal + sign-out affordance, rendered in the shared header.
 * A client component because sign-out calls the browser Better Auth client. When
 * no user is signed in (e.g. the public tag page) the parent renders nothing.
 */
export function UserMenu({ name, email }: { name: string; email: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const signOut = async () => {
    setBusy(true);
    await authClient.signOut();
    router.push("/sign-in");
    router.refresh();
  };
  return (
    <span className="user-menu">
      <span className="user-name">{name}</span>
      <span className="muted user-email">{email}</span>
      <button type="button" className="remove-btn" disabled={busy} onClick={signOut}>
        {busy ? "Signing out…" : "Sign out"}
      </button>
    </span>
  );
}
