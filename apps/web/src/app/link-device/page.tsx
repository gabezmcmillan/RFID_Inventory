import Link from "next/link";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isAuthEnabled } from "@/lib/auth";
import { isDevBypassActive } from "@/lib/dev-bypass";
import { getUser } from "@/lib/session";

import { generateLinkCode } from "./actions";
import { LinkDeviceClient } from "./LinkDeviceClient";

/**
 * `/link-device` — a signed-in web user generates a single-use, 5-minute
 * one-time token (server-side, via Better Auth's `oneTimeToken` plugin) and
 * renders it as a QR the phone scans to exchange for a long-lived bearer
 * credential (see `apps/field/src/auth/`). Listed in the user menu.
 *
 * When no auth backend is configured (the offline gate — `BETTER_AUTH_SECRET`
 * absent, including the dev-bypass path) the page renders a notice instead of
 * generating, so it still returns 200 in the dev smoke without a live backend.
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
              Set <code className="font-mono">BETTER_AUTH_SECRET</code> and <code className="font-mono">BETTER_AUTH_URL</code> to enable device
              linking.
            </p>
          )}
          <Button variant="outline" render={<Link href="/" />} className="mt-4">
            Back home
          </Button>
        </CardContent>
      </Card>
    );
  }

  const user = await getUser();
  if (!user) {
    redirect("/sign-in");
  }
  const token = await generateLinkCode();
  return (
    <main className="mx-auto max-w-5xl px-5 py-8">
      <LinkDeviceClient initialToken={token} />
    </main>
  );
}
