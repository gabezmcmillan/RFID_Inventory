"use client";

import { useState } from "react";

import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Single sign-on entry point. Microsoft Entra ID is the only sign-in method (no
 * password surface), so this is a one-button card. The OAuth flow navigates
 * away and creates the account on first sign-in. When SSO is not configured
 * (offline dev, CI, previews without credentials) the button is replaced with
 * a plain note.
 */
export function AuthForm({ microsoftEnabled }: { microsoftEnabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const signIn = async () => {
    setBusy(true);
    await authClient.signIn.social({ provider: "microsoft", callbackURL: "/" });
  };
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-background to-muted px-5 py-16">
      <div className="mb-8 text-center">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Brasfield &amp; Gorrie
        </p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-brand-navy dark:text-foreground">
          RFID Inventory
        </h1>
      </div>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>
            Sign in with your organization account to reach the warehouse.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {microsoftEnabled ? (
            <Button type="button" disabled={busy} onClick={signIn} className="w-full">
              {busy ? "Redirecting…" : "Continue with Microsoft"}
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">
              Single sign-on isn&apos;t configured for this environment.
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
