"use client";

import { useState } from "react";

import { authClient } from "@/lib/auth-client";

/**
 * Single sign-on entry point. Microsoft Entra ID is the only sign-in method
 * (no password surface), so this is a one-button card. The OAuth flow navigates
 * away and creates the account on first sign-in. When SSO is not configured
 * (offline dev, CI, previews without credentials) the button is replaced with
 * a plain note — the `effectivly` house style.
 */
export function AuthForm({ microsoftEnabled }: { microsoftEnabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const signIn = async () => {
    setBusy(true);
    await authClient.signIn.social({ provider: "microsoft", callbackURL: "/" });
  };
  return (
    <main className="container" style={{ maxWidth: 480, marginTop: "4rem" }}>
      <h1>Sign in</h1>
      <p className="muted">Sign in with your organization account to reach the warehouse.</p>
      {microsoftEnabled ? (
        <button type="button" className="add-btn" disabled={busy} onClick={signIn}>
          {busy ? "Redirecting…" : "Continue with Microsoft"}
        </button>
      ) : (
        <p className="muted">Single sign-on isn’t configured for this environment.</p>
      )}
    </main>
  );
}
