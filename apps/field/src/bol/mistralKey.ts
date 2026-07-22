/**
 * The Mistral OCR API key, stored in `expo-secure-store` (a settings field). The
 * domain client (`@rfid/domain`'s `extractFieldsViaMistral`) never reads
 * storage — the field app loads the key here and passes it in.
 */

import * as SecureStore from "expo-secure-store";

/** Secure-store key for the Mistral API key (plan 007 settings field). */
export const MISTRAL_API_KEY_STORAGE = "rfid.field.mistralApiKey";

/** Load the stored Mistral API key ("" when unset or unavailable). */
export async function loadMistralApiKey(): Promise<string> {
  try {
    return (await SecureStore.getItemAsync(MISTRAL_API_KEY_STORAGE)) ?? "";
  } catch {
    return "";
  }
}

/** Persist the Mistral API key (empty clears it). */
export async function saveMistralApiKey(value: string): Promise<void> {
  const trimmed = value.trim();
  if (trimmed) {
    await SecureStore.setItemAsync(MISTRAL_API_KEY_STORAGE, trimmed);
  } else {
    try {
      await SecureStore.deleteItemAsync(MISTRAL_API_KEY_STORAGE);
    } catch {
      /* already absent */
    }
  }
}
