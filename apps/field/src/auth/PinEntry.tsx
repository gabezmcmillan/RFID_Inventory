/**
 * Shared PIN entry card (plan 010, operator scope addition). One mechanism for
 * both gates: the device-unlock gate (`"device"`) and the admin-surface gate
 * (`"admin"`). Backed by the {@link PinStore} singleton with persisted
 * wrong-entry backoff and a live lockout countdown.
 *
 * Apple-passcode-style: the on-screen {@link PinPad} is already up and ready
 * (zero taps before typing), dots fill as digits are typed, the PIN
 * auto-submits when the last digit is entered, and a wrong PIN shakes the dots
 * and clears them so the operator can retype immediately. Replaces the ad-hoc
 * admin `PinPrompt` so there is a single PIN-entry design instead of two.
 */

import { useEffect, useState } from "react";
import { View } from "react-native";

import { Text } from "@/components/ui/text";
import { KeyboardDismissible } from "@/components/KeyboardDismissible";
import { PinPad } from "./PinPad";
import { pinStore } from "./pinStoreApp";
import type { PinSlot } from "./pinStore";

export interface PinEntryProps {
  /** Which PIN slot to verify against. */
  slot: PinSlot;
  /** Heading shown above the dots. */
  title: string;
  /** Placeholder for the entry field (unused by the keypad, kept for callers). */
  placeholder?: string;
  /** Optional node rendered above the title (e.g. the "RFID Field" wordmark on
   * the device lock overlay, which has no shell header). */
  header?: React.ReactNode;
  /** Center the group as a full-screen passcode panel (default `true`). Set
   * `false` when embedding in a compact card (e.g. the BOL delete gate). */
  centered?: boolean;
  /** Called once with `true` on a correct PIN. */
  onUnlock: () => void;
}

/**
 * A PIN entry card. Calls {@link onUnlock} on a match, shakes + clears on a
 * mismatch, and honors the persisted wrong-entry backoff (lockout countdown).
 *
 * The whole group (optional header, title, dots, keypad) is centered both
 * axes like Apple's passcode screen. `flex-1` lets it fill a standalone
 * screen (the admin gate); inside a centered wrapper (the lock overlay) the
 * `flex-1` is inert and the wrapper centers the block.
 */
export function PinEntry({ slot, title, placeholder = "PIN", header, centered = true, onUnlock }: PinEntryProps): React.ReactNode {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [errorSignal, setErrorSignal] = useState(0);
  const [lockoutUntil, setLockoutUntil] = useState(0);
  const [now, setNow] = useState(Date.now());

  // Tick once a second while a lockout is active so the countdown stays live.
  useEffect(() => {
    if (now >= lockoutUntil) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [now, lockoutUntil]);

  const locked = now < lockoutUntil;
  const remainingMs = locked ? lockoutUntil - now : 0;

  const submit = async (value: string): Promise<void> => {
    if (locked) return;
    const result = await pinStore.verify(slot, value);
    setNow(Date.now());
    if (result.ok) {
      onUnlock();
      return;
    }
    if (result.lockoutUntil > 0) {
      setLockoutUntil(result.lockoutUntil);
      setNow(Date.now());
      setError("Too many wrong attempts. Wait before retrying.");
    } else {
      setError("Invalid PIN.");
    }
    setErrorSignal((n) => n + 1); // shake + clear the dots
  };

  return (
    <KeyboardDismissible className={centered ? "flex-1 items-center justify-center p-5" : "items-center p-1"}>
      <View className={centered ? "w-full max-w-md items-center gap-10" : "w-full items-center gap-6"}>
        {header ? <View className="items-center">{header}</View> : null}
        <View className="items-center gap-2">
          {centered ? <Text className="text-2xl font-bold text-brand-navy">{title}</Text> : null}
          {error && !locked ? (
            <Text className="text-center text-destructive">{error}</Text>
          ) : null}
          {locked ? (
            <Text className="text-center text-destructive">
              Locked — wait {Math.ceil(remainingMs / 1000)}s.
            </Text>
          ) : null}
        </View>
        <PinPad
          value={pin}
          onChange={setPin}
          onSubmit={(v) => void submit(v)}
          errorSignal={errorSignal}
          disabled={locked}
        />
      </View>
    </KeyboardDismissible>
  );
}
