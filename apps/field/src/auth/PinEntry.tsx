/**
 * Shared PIN entry card (plan 010, operator scope addition). One mechanism for
 * both gates: the device-unlock gate (`"device"`) and the admin-surface gate
 * (`"admin"`). Backed by the {@link PinStore} singleton with persisted
 * wrong-entry backoff and a live lockout countdown. Replaces the ad-hoc admin
 * `PinPrompt` so there is a single PIN-entry design instead of two.
 */

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { KeyboardDismissible } from "@/components/KeyboardDismissible";
import { pinStore } from "./pinStoreApp";
import type { PinSlot } from "./pinStore";

export interface PinEntryProps {
  /** Which PIN slot to verify against. */
  slot: PinSlot;
  /** Heading shown above the entry field. */
  title: string;
  /** Placeholder for the entry field. */
  placeholder?: string;
  /** Called once with `true` on a correct PIN. */
  onUnlock: () => void;
}

/**
 * A PIN entry card. Calls {@link onUnlock} on a match, shows an error on a
 * mismatch, and honors the persisted wrong-entry backoff (lockout countdown).
 */
export function PinEntry({ slot, title, placeholder = "PIN", onUnlock }: PinEntryProps): React.ReactNode {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
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

  const submit = async (): Promise<void> => {
    if (locked) return;
    const result = await pinStore.verify(slot, pin);
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
    setPin("");
  };

  return (
    <KeyboardDismissible className="flex-1 p-5 gap-3">
      <Text className="text-2xl font-bold mb-2">{title}</Text>
      <Input
        value={pin}
        onChangeText={setPin}
        placeholder={placeholder}
        secureTextEntry
        keyboardType="number-pad"
        editable={!locked}
      />
      <Button disabled={locked} onPress={() => void submit()}>
        <Text>{locked ? `Wait ${Math.ceil(remainingMs / 1000)}s` : "Unlock"}</Text>
      </Button>
      {error && !locked ? <Text className="text-destructive mt-2">{error}</Text> : null}
    </KeyboardDismissible>
  );
}
