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
    <main className="mx-auto mt-16 w-full max-w-md px-5">
      <Card>
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
