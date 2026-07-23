/**
 * Full-screen device-unlock overlay (plan 010, operator scope addition).
 * Shown by {@link LockProvider} when the gate is locked. Uses the shared
 * {@link PinEntry} against the `"device"` slot; on a correct PIN,
 * {@link onUnlock} flips the gate to unlocked. Fully offline — no network.
 */

import { StyleSheet, View } from "react-native";

import { Text } from "@/components/ui/text";
import { PinEntry } from "./PinEntry";

export function LockScreen({ onUnlock }: { onUnlock: () => void }): React.ReactNode {
  return (
    <View style={StyleSheet.absoluteFill} className="bg-background items-center justify-center">
      <View className="w-full max-w-md px-6">
        <Text className="mb-8 text-center text-3xl font-extrabold tracking-tight text-brand-navy">RFID Field</Text>
        <PinEntry slot="device" title="Device PIN" onUnlock={onUnlock} />
      </View>
    </View>
  );
}
