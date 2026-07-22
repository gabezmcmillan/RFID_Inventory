/**
 * Dev Tools route (dev builds) — the no-hardware rig: a text box to inject one
 * or more EPCs via `readerService.injectScan`, the equivalent of
 * `POST /api/simulate_scan` (app.py:1065-1071), plus a "Insert sample request"
 * button that seeds a small cart order (two lines sharing an `order_ref`, one a
 * W.I.F. line carrying an `item_name`) via `createRequest` so the Requests
 * flow can be exercised end-to-end before plan 010 syncs real rows.
 */

import { createRequest } from "@rfid/domain";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { useDb } from "../src/db/provider";
import { readerService } from "../src/reader/readerService";
import { notifyRequestsChanged } from "../src/screens/requests/refresh";

export default function DevToolsScreen(): React.ReactNode {
  const db = useDb();
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const inject = (): void => {
    const epcs = text
      .split(/[\s,]+/)
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0);
    if (epcs.length === 0) return;
    readerService.injectScan(epcs);
    setText("");
  };

  const insertSampleRequest = async (): Promise<void> => {
    const orderRef = `CART-${Date.now().toString(36).toUpperCase()}`;
    await createRequest(db, {
      item_type: "TSC",
      quantity: 3,
      building: "6",
      jobsite: "North Tower",
      requester: "A. Rivera",
      contact: "arivera@example.com",
      note: "For the pour on Friday.",
      order_ref: orderRef,
    });
    await createRequest(db, {
      item_type: "W.I.F.",
      item_name: "Widget Bracket",
      quantity: 2,
      building: "6",
      jobsite: "North Tower",
      requester: "A. Rivera",
      contact: "arivera@example.com",
      note: "Match the bracket spec on drawing S-4.",
      order_ref: orderRef,
    });
    notifyRequestsChanged();
    setMsg("Inserted 2 sample requests (shared order_ref).");
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

      <View style={styles.divider} />

      <Text style={styles.label}>Requests</Text>
      <Pressable style={styles.button} onPress={() => void insertSampleRequest()}>
        <Text style={styles.buttonText}>Insert sample request</Text>
      </Pressable>
      {msg ? <Text style={styles.msg}>{msg}</Text> : null}
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
  divider: { height: 1, backgroundColor: "#eee", marginVertical: 4 },
  msg: { color: "#0a7", fontWeight: "600" },
});
