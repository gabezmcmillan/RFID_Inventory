/**
 * Dev Tools route (dev builds) — the no-hardware rig: a text box to inject one
 * or more EPCs via `readerService.injectScan`, the equivalent of
 * `POST /api/simulate_scan` (app.py:1065-1071).
 */

import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { readerService } from "../src/reader/readerService";

export default function DevToolsScreen(): React.ReactNode {
  const [text, setText] = useState("");

  const inject = (): void => {
    const epcs = text
      .split(/[\s,]+/)
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0);
    if (epcs.length === 0) return;
    readerService.injectScan(epcs);
    setText("");
  };

  return (
    <View style={styles.container}>
      <Text style={styles.label}>Inject EPCs (whitespace/comma separated)</Text>
      <TextInput
        style={styles.input}
        value={text}
        onChangeText={setText}
        placeholder="AAAA11112222333344445555"
        multiline
        autoCapitalize="characters"
      />
      <Pressable style={styles.button} onPress={inject}>
        <Text style={styles.buttonText}>Inject scan</Text>
      </Pressable>
      <Text style={styles.hint}>
        Tip: arm a shipment on the Check In screen first, then inject here to record it.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 12 },
  label: { fontSize: 14, fontWeight: "600" },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 6, padding: 12, fontSize: 14, minHeight: 80, fontFamily: "monospace" },
  button: { backgroundColor: "#0a7", padding: 14, borderRadius: 8, alignItems: "center" },
  buttonText: { color: "white", fontSize: 16, fontWeight: "600" },
  hint: { fontSize: 12, color: "#888" },
});
