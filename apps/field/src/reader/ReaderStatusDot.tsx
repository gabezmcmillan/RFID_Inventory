/**
 * A minimal reader-connection indicator for the shell header — a single
 * colored dot on the right of the navy header (green = reader connected,
 * muted gray = not connected). No "Connected" text: the dot is the whole
 * signal, the same way the home chip used to say it. Tap navigates to
 * Settings so an operator who notices the gray dot can connect the sled.
 *
 * Subscribes to the shared {@link readerService} singleton so it updates
 * live on every screen that renders the shell header.
 */

import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";

import { readerService } from "./readerService";

export function ReaderStatusDot(): React.ReactNode {
  const router = useRouter();
  const [connected, setConnected] = useState(readerService.connected);

  useEffect(() => {
    const unsub = readerService.subscribe((e) => {
      if (e.event === "status") setConnected(e.connected);
    });
    return unsub;
  }, []);

  return (
    <Pressable
      onPress={() => router.push("/settings")}
      hitSlop={12}
      className="items-center justify-center px-2 py-1.5 active:opacity-60"
      accessibilityLabel={connected ? "Reader connected" : "Reader not connected"}
      accessibilityRole="button"
    >
      <View
        className={`h-2.5 w-2.5 rounded-full ${
          connected ? "bg-status-in" : "bg-muted-foreground/50"
        }`}
      />
    </Pressable>
  );
}
