/**
 * Settings route — transport toggle (Simulated / Bluetooth sled, persisted via
 * `AsyncStorage`) and a check-power slider (10–29 dBm) calling
 * `readerService.setCheckPower` (mirrors app.py:262-268).
 */

import { useEffect, useState } from "react";
import { Platform, Pressable, StyleSheet, Switch, Text, View } from "react-native";

import { readerService, USE_NATIVE_TRANSPORT_KEY } from "../src/reader/readerService";

const MIN_POWER = 10;
const MAX_POWER = 29;

export default function SettingsScreen(): React.ReactNode {
  const [useNative, setUseNative] = useState(false);
  const [power, setPower] = useState(20);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void readerService.init().then(() => setUseNative(readerService.useNativeTransport));
  }, []);

  const toggleTransport = async (value: boolean): Promise<void> => {
    setBusy(true);
    try {
      await readerService.setUseNativeTransport(value);
      setUseNative(value);
    } finally {
      setBusy(false);
    }
  };

  const adjustPower = (delta: number): void => {
    const next = Math.min(MAX_POWER, Math.max(MIN_POWER, power + delta));
    setPower(next);
    readerService.setCheckPower(next);
  };

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <View>
          <Text style={styles.label}>Native Bluetooth sled</Text>
          <Text style={styles.hint}>Off = simulated reader (dev)</Text>
        </View>
        <Switch value={useNative} onValueChange={(v) => void toggleTransport(v)} disabled={busy} />
      </View>

      <View style={styles.row}>
        <Text style={styles.label}>Check power</Text>
        <View style={styles.powerRow}>
          <Pressable style={styles.stepBtn} onPress={() => adjustPower(-1)}>
            <Text style={styles.stepText}>−</Text>
          </Pressable>
          <Text style={styles.powerValue}>{power} dBm</Text>
          <Pressable style={styles.stepBtn} onPress={() => adjustPower(1)}>
            <Text style={styles.stepText}>+</Text>
          </Pressable>
        </View>
      </View>

      {Platform.OS === "ios" ? (
        <Text style={styles.note}>
          Toggle key: <Text style={styles.mono}>{USE_NATIVE_TRANSPORT_KEY}</Text>
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 16 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  label: { fontSize: 16, fontWeight: "600" },
  hint: { fontSize: 12, color: "#888" },
  powerRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  stepBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: "#eee", alignItems: "center", justifyContent: "center" },
  stepText: { fontSize: 22, fontWeight: "600" },
  powerValue: { fontSize: 16, fontWeight: "600", minWidth: 64, textAlign: "center" },
  note: { fontSize: 12, color: "#888", marginTop: 8 },
  mono: { fontFamily: "monospace" },
});
