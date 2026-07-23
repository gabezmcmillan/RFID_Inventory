/**
 * Set-device-PIN route (plan 010, operator scope addition). Reached immediately
 * after a successful QR link + register. The linker sets the device PIN that
 * gates the app from then on (the linker may not be the daily user, so the PIN
 * is what the operator on the floor enters to unlock). Requires the PIN twice
 * to guard a typo, then arms the gate via {@link useLock().setDevicePin} and
 * goes home. Offline-capable: the hash is stored locally in the Keychain.
 *
 * Apple-passcode-style: the on-screen {@link PinPad} is up and ready, dots fill
 * as typed, the entry auto-advances from "enter" to "confirm" when the last
 * digit is entered, and auto-submits from confirm. A mismatch shakes + clears
 * back to the enter step.
 */

import { useEffect, useState } from "react";
import { useNavigation, useRouter } from "expo-router";
import { View } from "react-native";

import { Text } from "@/components/ui/text";
import { KeyboardDismissible } from "@/components/KeyboardDismissible";
import { PinPad } from "../src/auth/PinPad";
import { useLock } from "../src/auth/LockProvider";

type Step = "enter" | "confirm";

export default function SetPinScreen(): React.ReactNode {
  const router = useRouter();
  const navigation = useNavigation();
  const lock = useLock();
  const [step, setStep] = useState<Step>("enter");
  const [first, setFirst] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [errorSignal, setErrorSignal] = useState(0);
  const [busy, setBusy] = useState(false);

  // The shell header owns the screen title; reflect the current step there so
  // the body doesn't have to repeat it.
  useEffect(() => {
    navigation.setOptions({ title: step === "enter" ? "Set Device PIN" : "Confirm PIN" });
  }, [navigation, step]);

  const resetToEnter = (msg: string): void => {
    setError(msg);
    setFirst("");
    setConfirm("");
    setStep("enter");
    setErrorSignal((n) => n + 1);
  };

  const onEnterComplete = (pin: string): void => {
    if (pin.length < 4) {
      resetToEnter("PIN must be at least 4 digits.");
      return;
    }
    setError(null);
    setFirst(pin);
    setStep("confirm");
    setConfirm("");
  };

  const onConfirmComplete = async (pin: string): Promise<void> => {
    if (busy) return;
    if (pin !== first) {
      resetToEnter("PINs do not match. Try again.");
      return;
    }
    setBusy(true);
    try {
      await lock?.setDevicePin(pin);
      // The gate is now armed (unlocked — the linker just authenticated). Go home.
      router.replace("/");
    } catch (err) {
      resetToEnter(err instanceof Error ? err.message : "Could not set PIN.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardDismissible className="flex-1 items-center justify-center p-6 pb-10">
      <View className="w-full max-w-md items-center gap-10">
        <View className="items-center gap-2">
          <Text className="text-center text-sm leading-snug text-muted-foreground">
            {step === "enter"
              ? "This PIN unlocks the app on this device. The person who links the device may not be the person using it day-to-day, so share this PIN with the warehouse operator."
              : "Re-enter the PIN to confirm."}
          </Text>
          {error ? <Text className="text-center text-destructive">{error}</Text> : null}
        </View>

        {step === "enter" ? (
          <PinPad
            value={first}
            onChange={setFirst}
            onSubmit={onEnterComplete}
            errorSignal={errorSignal}
          />
        ) : (
          <PinPad
            value={confirm}
            onChange={setConfirm}
            onSubmit={(v) => void onConfirmComplete(v)}
            errorSignal={errorSignal}
          />
        )}
      </View>
    </KeyboardDismissible>
  );
}
