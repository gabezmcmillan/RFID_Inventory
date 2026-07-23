/**
 * Admin-surface PIN gate (plan 006/007, reconciled under plan 010's scope
 * addition). The PIN is a salted hash in the iOS Keychain via the shared
 * {@link PinStore} (`"admin"` slot) — NOT the legacy plaintext AsyncStorage
 * value. The first time the admin surface opens after upgrade, the legacy
 * plaintext PIN (`rfid.field.adminPin`, default "1234") is migrated into the
 * hashed slot and removed, so existing operator access keeps working until
 * the PIN is changed.
 *
 * The entry UI is the shared {@link PinEntry} (one PIN-entry mechanism for both
 * the admin and device gates). Shared by the Admin screen and the BOL-documents
 * delete gate so there is one source of truth for the admin PIN.
 */

import { useEffect } from "react";

import { PinEntry } from "../auth/PinEntry";
import { migrateLegacyAdminPinOnce, pinStore } from "../auth/pinStoreApp";

/** Set (replace) the admin PIN. Throws a user-facing message on an invalid PIN. */
export async function setAdminPin(pin: string): Promise<void> {
  await pinStore.setPin("admin", pin);
}

/**
 * A PIN entry card for the admin surface. Migrates the legacy plaintext admin
 * PIN on first open, then delegates to the shared {@link PinEntry}.
 */
export function PinPrompt({
  onUnlock,
  centered = true,
}: {
  onUnlock: () => void;
  centered?: boolean;
}): React.ReactNode {
  useEffect(() => {
    void migrateLegacyAdminPinOnce();
  }, []);
  return <PinEntry slot="admin" title="Admin PIN" centered={centered} onUnlock={onUnlock} />;
}
