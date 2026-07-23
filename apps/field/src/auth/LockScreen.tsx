/**
 * Full-screen device-unlock overlay (plan 010, operator scope addition).
 * Shown by {@link LockProvider} when the gate is locked. Uses the shared
 * {@link PinEntry} against the `"device"` slot; on a correct PIN,
 * {@link onUnlock} flips the gate to unlocked. Fully offline — no network.
 *
 * The overlay covers the whole screen (no shell header), so it pads itself
 * with the safe-area insets. The outer view is full-size (absoluteFill) and
 * stretches its child; {@link PinEntry} is `flex-1`, so it fills that height
 * and centers its group (wordmark + title + dots + keypad) as one unit —
 * like Apple's passcode. There is NO content-sized wrapper between them,
 * because such a wrapper collapses the `flex-1` chain and the group falls
 * out of center.
 */

import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Text } from "@/components/ui/text";
import { PinEntry } from "./PinEntry";

export function LockScreen({ onUnlock }: { onUnlock: () => void }): React.ReactNode {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[StyleSheet.absoluteFill, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}
      className="bg-background"
    >
      <PinEntry
        slot="device"
        title="Enter device PIN"
        header={
          <Text className="text-3xl font-extrabold tracking-tight text-brand-navy">
            RFID Field
          </Text>
        }
        onUnlock={onUnlock}
      />
    </View>
  );
}
