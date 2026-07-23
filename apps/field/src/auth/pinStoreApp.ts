/**
 * Process-wide {@link PinStore} singleton for the field app (plan 010, operator
 * scope addition). Backed by the real `expo-secure-store` (iOS Keychain) and
 * `AsyncStorage` (for the one-time legacy admin-PIN migration). Both the device
 * unlock gate and the admin-surface gate share this one instance.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

import { PinStore } from "./pinStore";

/**
 * expo-secure-store's surface matches {@link SecureStoreLike} directly
 * (`getItemAsync` / `setItemAsync` / `deleteItemAsync`).
 */
const secureStore = SecureStore;

/** AsyncStorage provides only `getItem`/`removeItem` for the legacy migration. */
const asyncStorage = {
  getItem: (k: string) => AsyncStorage.getItem(k),
  removeItem: (k: string) => AsyncStorage.removeItem(k),
};

/** The single app-wide PIN store. */
export const pinStore = new PinStore(secureStore, asyncStorage);

let migrated = false;

/**
 * Run the legacy plaintext admin-PIN migration once per process launch. Safe
 * to call repeatedly (it short-circuits after the first run); the underlying
 * {@link PinStore.migrateLegacyAdminPin} is itself idempotent. Called on app
 * start and on first admin-surface open.
 */
export async function migrateLegacyAdminPinOnce(): Promise<void> {
  if (migrated) return;
  migrated = true;
  try {
    await pinStore.migrateLegacyAdminPin();
  } catch {
    // Migration is best-effort; a failure (e.g. Keychain unavailable) must not
    // block app launch. The admin gate simply has no PIN until the operator
    // sets one.
  }
}
