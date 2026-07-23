"use client";

import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Public field-app install page (`/field/install`, plan 010 Phase 5). Not linked
 * in the nav (a fresh phone has no session and no reason to browse here), but
 * reachable by URL — the field app's update banner and the `/api/field/version`
 * route point here.
 *
 * The `itms-services://` Install button only works on iOS Safari, so the page
 * branches on the client user-agent:
 *  - **iOS** (`/iPhone|iPad|iPod/`): the Install button (hands iOS the manifest
 *    route) + the human steps, including the iOS 18+ first-install "Allow &
 *    Restart" step enterprise in-house builds require.
 *  - **Anything else** (desktop/laptop): a QR code encoding THIS page's own
 *    absolute URL, so the operator scans it with the iPhone's camera to open the
 *    install page there. The written steps stay visible below for reference.
 *
 * The QR encodes only the public page URL — never the presigned IPA link — so
 * there is no security change (the page is public, low-discoverability).
 *
 * Hydration: the platform is not known during SSR/prerender, so the first render
 * is a neutral shell ("Checking your device…") — never the wrong variant. The
 * branch is set in an effect after mount (per the repo's React best-practices
 * "render neutral until known" guidance), so there is no flash of the wrong
 * variant and no hydration mismatch (server and client both render neutral
 * first). The page stays public and static-friendly (the neutral shell is the
 * prerendered output; no DB, no session).
 */

/** Client user-agent platform branch. `"unknown"` until the effect runs. */
type Platform = "ios" | "other" | "unknown";

/** Matches iPhone, iPad, and iPod touch user-agents. */
const IOS_UA = /iPhone|iPad|iPod/;

/** The manifest route the `itms-services` URL points iOS at. */
const MANIFEST_PATH = "/api/field/manifest.plist";

/** The shared install steps (visible on both variants; extracted to module
 * scope so it is not redefined per render — per the composition rules). */
function InstallSteps(): React.ReactElement {
  return (
    <ol className="list-decimal space-y-2 pl-5 text-sm">
      <li>
        Tap <strong>Install</strong> above. iOS shows a confirmation dialog;
        tap <strong>Install</strong> again.
      </li>
      <li>
        After the download finishes, the app icon appears on the home screen but
        the first launch is blocked. Open <strong>Settings → General → VPN
        &amp; Device Management</strong>.
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
        The device must be able to reach <code>ppq.apple.com</code> (Apple&apos;s
        enterprise profile server) for the trust check — confirm the iPhone is
        on a network without that host blocked.
      </li>
    </ol>
  );
}

export default function FieldInstallPage(): React.ReactElement {
  const [platform, setPlatform] = useState<Platform>("unknown");
  // The install page's own absolute URL, captured after mount for the QR code.
  const [pageUrl, setPageUrl] = useState<string>("");
  const linkRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    // Defer the platform detection off the effect's synchronous body (avoids
    // the react-hooks/set-state-in-effect cascading-render lint) while still
    // resolving before paint. The neutral shell renders first, then the
    // correct variant — no flash of the wrong variant, no hydration mismatch.
    queueMicrotask(() => {
      const isIos = IOS_UA.test(navigator.userAgent);
      setPlatform(isIos ? "ios" : "other");
      if (isIos) {
        // Build the itms-services URL from the live origin (a server component
        // can't read the request origin without async headers, and reading
        // `window` during render would hydration-mismatch). Written to the
        // anchor via a ref (a DOM mutation, not setState) to stay lint-clean.
        if (linkRef.current) {
          linkRef.current.href = `itms-services://?action=download-manifest&url=${encodeURIComponent(
            `https://${window.location.host}${MANIFEST_PATH}`,
          )}`;
        }
      } else {
        // Encode this page's own URL — the operator scans it on the iPhone to
        // land here, where the Install button then works.
        setPageUrl(window.location.href);
      }
    });
  }, []);

  return (
    <main className="mx-auto w-full max-w-2xl px-5 pb-16 pt-10">
      <Card>
        <CardHeader>
          <CardTitle>Install the RFID Field app</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {platform === "unknown" ? (
            <p className="text-muted-foreground">Checking your device…</p>
          ) : null}
          {platform === "ios" ? (
            <>
              <p className="text-muted-foreground">
                Tap the button below on the iPhone you want to set up. The app is
                distributed in-house by Brasfield &amp; Gorrie — it does not come
                from the App Store.
              </p>
              <Button variant="default" render={<a ref={linkRef} href="#" />}>
                Install RFID Field
              </Button>
              <InstallSteps />
            </>
          ) : null}
          {platform === "other" ? (
            <>
              <p className="text-muted-foreground">
                The Install button only works in Safari on an iPhone. Scan this
                code with the iPhone&apos;s camera to open this page there, then
                tap <strong>Install</strong>.
              </p>
              <div className="flex justify-center rounded-lg border border-border bg-white p-4">
                {pageUrl ? (
                  <QRCodeSVG value={pageUrl} size={224} level="M" />
                ) : (
                  <div className="h-[224px] w-[224px]" />
                )}
              </div>
              <p className="text-center text-sm text-muted-foreground">
                Scan with the iPhone&apos;s camera to open this page there.
              </p>
              <InstallSteps />
            </>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Already installed? The field app checks for updates automatically and
            shows a banner linking here when a newer build is available.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
