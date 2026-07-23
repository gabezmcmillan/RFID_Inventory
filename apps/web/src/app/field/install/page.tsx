"use client";

import { useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Public field-app install page (`/field/install`, plan 010 Phase 5). Not linked
 * in the nav (a fresh phone has no session and no reason to browse here), but
 * reachable by URL — the field app's update banner and the `/api/field/version`
 * route point here. Renders the `itms-services://` install button (which hands
 * iOS the manifest route) plus the human steps, including the iOS 18+
 * first-install "Allow & Restart" step that enterprise in-house builds require.
 *
 * Client component so the `itms-services://` URL can be built from the live
 * origin after mount (a server component can't read the request origin without
 * async headers, and reading `window` during render would hydration-mismatch).
 * The href is written to the anchor via a ref in an effect (a DOM mutation,
 * not setState) to stay lint-clean.
 */
export default function FieldInstallPage(): React.ReactElement {
  const manifestPath = "/api/field/manifest.plist";
  const linkRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (!linkRef.current) return;
    linkRef.current.href = `itms-services://?action=download-manifest&url=${encodeURIComponent(
      `https://${window.location.host}${manifestPath}`,
    )}`;
  }, []);

  return (
    <main className="mx-auto w-full max-w-2xl px-5 pb-16 pt-10">
      <Card>
        <CardHeader>
          <CardTitle>Install the RFID Field app</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground">
            Tap the button below on the iPhone you want to set up. The app is
            distributed in-house by Brasfield &amp; Gorrie — it does not come
            from the App Store.
          </p>
          <Button variant="default" render={<a ref={linkRef} href="#" />}>
            Install RFID Field
          </Button>
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>
              Tap <strong>Install</strong> above. iOS shows a confirmation
              dialog; tap <strong>Install</strong> again.
            </li>
            <li>
              After the download finishes, the app icon appears on the home screen
              but the first launch is blocked. Open <strong>Settings → General →
              VPN &amp; Device Management</strong>.
            </li>
            <li>
              Tap <strong>Brasfield &amp; Gorrie, LLC</strong>, then tap
              <strong> Allow &quot;Brasfield &amp; Gorrie, LLC&quot;</strong> and
              confirm. (iOS 18+ calls this <strong>Allow &amp; Restart</strong>.)
            </li>
            <li>
              The device restarts. After it boots, the RFID Field app launches
              normally. This trust step is only needed once per device.
            </li>
            <li>
              The device must be able to reach <code>ppq.apple.com</code>
              (Apple&apos;s enterprise profile server) for the trust check —
              confirm the iPhone is on a network without that host blocked.
            </li>
          </ol>
          <p className="text-xs text-muted-foreground">
            Already installed? The field app checks for updates automatically and
            shows a banner linking here when a newer build is available.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
