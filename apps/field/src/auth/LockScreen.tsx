/**
 * Full-screen device-unlock overlay (plan 010, operator scope addition).
 * Shown by {@link LockProvider} when the gate is locked. Uses the shared
 * {@link PinEntry} against the `"device"` slot; on a correct PIN,
 * {@link onUnlock} flips the gate to unlocked. Fully offline — no network.
 *
 * The overlay covers the whole screen (no shell header), so it pads itself
 * with the safe-area insets and centers the "RFID Field" wordmark + PIN group
 * (dots in the upper-middle, keypad centered below) like Apple's passcode.
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
      className="bg-background items-center justify-center"
    >
      <View className="w-full max-w-md px-6">
        <PinEntry
          slot="device"
          title="Device PIN"
          header={
            <Text className="text-3xl font-extrabold tracking-tight text-brand-navy">
              RFID Field
            </Text>
          }
          onUnlock={onUnlock}
        />
      </View>
    </View>
  );
}
