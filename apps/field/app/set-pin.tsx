/**
 * Set-device-PIN route (plan 010, operator scope addition). Reached immediately
 * after a successful QR link + register. The linker sets the device PIN that
 * gates the app from then on (the linker may not be the daily user, so the PIN
 * is what the operator on the floor enters to unlock). Requires the PIN twice to
 * guard a typo, then arms the gate via {@link useLock().setDevicePin} and goes
 * home. Offline-capable: the hash is stored locally in the Keychain.
 */

import { useState } from "react";
import { ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { KeyboardDismissible } from "@/components/KeyboardDismissible";
import { useLock } from "../src/auth/LockProvider";

export default function SetPinScreen(): React.ReactNode {
  const router = useRouter();
  const lock = useLock();
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setError(null);
    if (pin.length < 4) {
      setError("PIN must be at least 4 digits.");
      return;
    }
    if (pin !== confirm) {
      setError("PINs do not match.");
      return;
    }
    setBusy(true);
    try {
      await lock?.setDevicePin(pin);
      // The gate is now armed (unlocked — the linker just authenticated). Go home.
      router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set PIN.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardDismissible className="flex-1 p-6 gap-3">
      <Text className="text-2xl font-bold mb-2">Set device PIN</Text>
      <Text className="text-sm text-muted-foreground mb-2">
        This PIN unlocks the app on this device. The person who links the device may not be the
        person using it day-to-day, so share this PIN with the warehouse operator.
      </Text>
      <Input
        value={pin}
        onChangeText={setPin}
        placeholder="New PIN (4–8 digits)"
        secureTextEntry
        keyboardType="number-pad"
      />
      <Input
        value={confirm}
        onChangeText={setConfirm}
        placeholder="Confirm PIN"
        secureTextEntry
        keyboardType="number-pad"
      />
      <Button disabled={busy} onPress={() => void submit()}>
        {busy ? <ActivityIndicator /> : <Text>Set PIN and finish</Text>}
      </Button>
      {error ? <Text className="text-destructive mt-2">{error}</Text> : null}
    </KeyboardDismissible>
  );
}
