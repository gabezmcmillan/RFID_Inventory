import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isAuthEnabled } from "@/lib/auth";
import { isDevBypassActive } from "@/lib/dev-bypass";
import { getRealSessionUser } from "@/lib/session";

import { generateLinkCode } from "./actions";
import { LinkDeviceClient } from "./LinkDeviceClient";

/**
 * `/link-device` — a signed-in web user generates a single-use, 5-minute
 * one-time token (server-side, via Better Auth's `oneTimeToken` plugin) and
 * renders it as a QR the phone scans to exchange for a long-lived bearer
 * credential (see `apps/field/src/auth/`). Listed in the user menu.
 *
 * The token is minted against the caller's REAL Better Auth session cookie, so
 * this page resolves the principal with {@link getRealSessionUser} (which
 * ignores the dev bypass). Three states:
 *
 * 1. No auth backend (offline gate — `BETTER_AUTH_SECRET` absent, including the
 *    dev-bypass path with no secret): render a notice. Never mint.
 * 2. Auth backend configured but no REAL session (the dev-bypass fake user, or
 *    an unauthenticated visitor): render a clear sign-in-required state with a
 *    link to `/sign-in`. Never mint — `generateOneTimeToken` would throw
 *    `APIError: Unauthorized` against a non-existent session.
 * 3. A real session is present: mint the single-use token and render the QR.
 */
export default async function LinkDevicePage() {
  if (!isAuthEnabled()) {
    return (
      <Card className="mx-auto mt-10 max-w-md">
        <CardHeader>
          <CardTitle>Link a device</CardTitle>
          <CardDescription>Device linking needs a configured auth backend.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {isDevBypassActive() ? (
            <p>
              The dev bypass is active, so there is no live auth backend to mint a one-time code.
              Set <code className="font-mono">BETTER_AUTH_SECRET</code> (and Entra ID credentials)
              to sign in and link a device.
            </p>
          ) : (
            <p>
              Set <code className="font-mono">BETTER_AUTH_SECRET</code> and{" "}
              <code className="font-mono">BETTER_AUTH_URL</code> to enable device linking.
            </p>
          )}
          <Button variant="outline" render={<Link href="/" />} className="mt-4">
            Back home
          </Button>
        </CardContent>
      </Card>
    );
  }

  // Minting requires a REAL Better Auth session — the dev-bypass fake user is
  // not enough (the oneTimeToken plugin validates the session cookie). Without
  // one, render a sign-in-required state instead of throwing Unauthorized.
  const user = await getRealSessionUser();
  if (!user) {
    return (
      <Card className="mx-auto mt-10 max-w-md">
        <CardHeader>
          <CardTitle>Sign in required</CardTitle>
          <CardDescription>
            {isDevBypassActive()
              ? "The dev bypass is active, but linking a device needs a real signed-in session."
              : "Linking a device needs a signed-in session."}
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p className="mb-4">
            Sign in with your organization account, then open this page to generate a one-time
            code the phone can scan.
          </p>
          <Button render={<Link href="/sign-in" />}>Sign in</Button>
        </CardContent>
      </Card>
    );
  }

  const token = await generateLinkCode();
  return (
    <main className="mx-auto max-w-5xl px-5 py-8">
      <LinkDeviceClient initialToken={token} />
    </main>
  );
}
