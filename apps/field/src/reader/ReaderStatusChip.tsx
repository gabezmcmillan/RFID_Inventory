/**
 * Reader-connection chip for the shell header — a compact pill that pairs a
 * status dot (green = reader connected, muted gray = not connected) with the
 * word "Reader" in small caps. Replaces the bare dot from 4a0c23b, which
 * operators found too minimal to read at a glance on the navy header.
 *
 * The pill is flat and solid — a subtle off-white navy tint with a hairline
 * border — deliberately NOT frosted/liquid-glass, per operator feedback. The
 * navy label and status dot read on the header in both connected and
 * disconnected states. Tap navigates to Settings so an operator who notices
 * the gray dot can connect the sled.
 *
 * Subscribes to the shared {@link readerService} singleton so it updates live
 * on every screen that renders the shell header.
 */

import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";

import { Text } from "@/components/ui/text";

import { readerService } from "./readerService";

export function ReaderStatusChip(): React.ReactNode {
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
      hitSlop={8}
      className="flex-row items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-1 active:opacity-60"
      accessibilityLabel={connected ? "Reader connected" : "Reader not connected"}
      accessibilityRole="button"
    >
      <View
        className={`h-2 w-2 rounded-full ${
          connected ? "bg-status-in" : "bg-muted-foreground/60"
        }`}
      />
      <Text className="text-xs font-semibold uppercase tracking-wider text-brand-navy">
        Reader
      </Text>
    </Pressable>
  );
}
