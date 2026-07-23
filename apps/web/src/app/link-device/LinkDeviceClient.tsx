"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { QRCodeSVG } from "qrcode.react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { generateLinkCode } from "./actions";

/**
 * Client half of the device-linking page: renders the one-time token as a QR
 * the phone scans, with a live 5-minute expiry countdown and a "New code"
 * button that asks the server action for a fresh single-use token. The token
 * itself never leaves the server's authority — the client only displays it.
 */
const EXPIRY_SECONDS = 5 * 60;

export function LinkDeviceClient({ initialToken }: { initialToken: string }) {
  const [token, setToken] = useState(initialToken);
  const [remaining, setRemaining] = useState(EXPIRY_SECONDS);
  const [busy, startTransition] = useTransition();

  const regenerate = useCallback(() => {
    startTransition(async () => {
      const next = await generateLinkCode();
      if (next) {
        setToken(next);
        setRemaining(EXPIRY_SECONDS);
      }
    });
  }, []);

  // Countdown; when it hits zero the QR is stale until regenerated.
  useEffect(() => {
    if (!token) return;
    if (remaining <= 0) return;
    const id = setInterval(() => setRemaining((r) => Math.max(0, r - 1)), 1000);
    return () => clearInterval(id);
  }, [token, remaining]);

  const mm = Math.floor(remaining / 60).toString().padStart(2, "0");
  const ss = (remaining % 60).toString().padStart(2, "0");
  const expired = remaining <= 0;

  return (
    <Card className="mx-auto max-w-md">
      <CardHeader>
        <CardTitle>Link a device</CardTitle>
        <CardDescription>
          On the phone, open Settings → Link device and scan this code. It is single-use and
          expires in 5 minutes.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-4">
        <div
          className={`rounded-lg border border-border bg-white p-4 ${expired ? "opacity-40" : ""}`}
        >
          {expired ? (
            <div className="flex h-[224px] w-[224px] items-center justify-center text-center text-sm text-muted-foreground">
              Code expired.
              <br />
              Generate a new one.
            </div>
          ) : (
            <QRCodeSVG value={token} size={224} level="M" />
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Expires in <span className="font-mono text-foreground">{`${mm}:${ss}`}</span>
        </p>
        <Button variant="outline" disabled={busy} onClick={regenerate}>
          {busy ? "Generating…" : "New code"}
        </Button>
      </CardContent>
    </Card>
  );
}
