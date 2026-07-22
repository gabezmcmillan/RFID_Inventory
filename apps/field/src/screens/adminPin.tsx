/**
 * Admin PIN gate (plan 006): "light protection for a trusted machine, not real
 * security". The PIN lives in AsyncStorage (default "1234"); a correct PIN
 * unlocks the admin surface. Shared by the Admin screen and the BOL-documents
 * delete gate (plan 007 step 4) so there is one source of truth for the PIN.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

/** AsyncStorage key for the admin PIN (config.py:159). */
export const ADMIN_PIN_KEY = "rfid.field.adminPin";
/** Default PIN (config.py:159). */
export const DEFAULT_ADMIN_PIN = "1234";

/** Load the stored admin PIN (default when unset). */
export async function loadAdminPin(): Promise<string> {
  return (await AsyncStorage.getItem(ADMIN_PIN_KEY)) ?? DEFAULT_ADMIN_PIN;
}

/** Persist a new admin PIN. */
export async function saveAdminPin(pin: string): Promise<void> {
  await AsyncStorage.setItem(ADMIN_PIN_KEY, pin);
}

/** True when `candidate` matches the stored PIN. */
export async function verifyAdminPin(candidate: string): Promise<boolean> {
  return candidate === (await loadAdminPin());
}

/**
 * A PIN entry card. Calls {@link onUnlock} on a match, shows an error on a
 * mismatch. Used by the Admin screen and the BOL-doc delete gate.
 */
export function PinPrompt({ onUnlock }: { onUnlock: () => void }): React.ReactNode {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (await verifyAdminPin(pin)) {
      onUnlock();
    } else {
      setError("Invalid PIN.");
      setPin("");
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Admin PIN</Text>
      <TextInput
        style={styles.input}
        value={pin}
        onChangeText={setPin}
        placeholder="PIN"
        secureTextEntry
        keyboardType="number-pad"
      />
      <Pressable style={styles.primary} onPress={() => void submit()}>
        <Text style={styles.primaryText}>Unlock</Text>
      </Pressable>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 12 },
  title: { fontSize: 22, fontWeight: "bold", marginBottom: 8 },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 6, padding: 10, fontSize: 16 },
  primary: { backgroundColor: "#0a7", padding: 14, borderRadius: 8, alignItems: "center" },
  primaryText: { color: "white", fontWeight: "600" },
  error: { color: "#c33", marginTop: 8 },
});
