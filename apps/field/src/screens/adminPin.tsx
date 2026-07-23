/**
 * Admin-surface PIN gate (plan 006/007, reconciled under plan 010's scope
 * addition). The PIN is now a salted hash in the iOS Keychain via the shared
 * {@link PinStore} (`"admin"` slot) — NOT the legacy plaintext AsyncStorage
 * value. The first time the admin surface opens after upgrade, the legacy
 * plaintext PIN (`rfid.field.adminPin`, default "1234") is migrated into the
 * hashed slot and removed, so existing operator access keeps working until
 * the PIN is changed.
 *
 * Shared by the Admin screen and the BOL-documents delete gate so there is one
 * source of truth for the admin PIN — and the same mechanism as the device
 * unlock gate (different slot, same crypto/backoff).
 */

import { useEffect, useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { migrateLegacyAdminPinOnce, pinStore } from "../auth/pinStoreApp";

/** Set (replace) the admin PIN. Throws a user-facing message on an invalid PIN. */
export async function setAdminPin(pin: string): Promise<void> {
  await pinStore.setPin("admin", pin);
}

/**
 * A PIN entry card. Calls {@link onUnlock} on a match, shows an error on a
 * mismatch, and honors the persisted wrong-entry backoff (lockout countdown).
 * Used by the Admin screen and the BOL-doc delete gate.
 */
export function PinPrompt({ onUnlock }: { onUnlock: () => void }): React.ReactNode {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [lockoutUntil, setLockoutUntil] = useState(0);
  const [now, setNow] = useState(Date.now());

  // Migrate the legacy plaintext admin PIN into the hashed slot on first open.
  useEffect(() => {
    void migrateLegacyAdminPinOnce();
  }, []);

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
    const result = await pinStore.verify("admin", pin);
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
    <View className="flex-1 p-5 gap-3">
      <Text className="text-2xl font-bold mb-2">Admin PIN</Text>
      <Input
        value={pin}
        onChangeText={setPin}
        placeholder="PIN"
        secureTextEntry
        keyboardType="number-pad"
        editable={!locked}
      />
      <Button disabled={locked} onPress={() => void submit()}>
        <Text>{locked ? `Wait ${Math.ceil(remainingMs / 1000)}s` : "Unlock"}</Text>
      </Button>
      {error && !locked ? <Text className="text-destructive mt-2">{error}</Text> : null}
    </View>
  );
}
