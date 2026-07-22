/**
 * Mode home — the landing screen. Shows the current reader mode and offers
 * navigation to Check In, Settings, and Dev Tools. Mode is driven by the
 * reader service; this screen keeps the reader idle.
 */

import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { readerService } from "../src/reader/readerService";

export default function HomeScreen(): React.ReactNode {
  const [connected, setConnected] = useState(readerService.connected);
  useEffect(() => {
    const unsub = readerService.subscribe((e) => {
      if (e.event === "status") setConnected(e.connected);
    });
    return unsub;
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>RFID Field</Text>
      <Text style={styles.status}>
        Reader: {connected ? "connected" : "disconnected"}
      </Text>
      <Link href="/check-in" asChild>
        <Pressable style={styles.button}>
          <Text style={styles.buttonText}>Check In</Text>
        </Pressable>
      </Link>
      <Link href="/settings" asChild>
        <Pressable style={styles.button}>
          <Text style={styles.buttonText}>Settings</Text>
        </Pressable>
      </Link>
      <Link href="/dev-tools" asChild>
        <Pressable style={styles.buttonSecondary}>
          <Text style={styles.buttonText}>Dev Tools</Text>
        </Pressable>
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, gap: 12, justifyContent: "center" },
  title: { fontSize: 28, fontWeight: "bold", marginBottom: 8 },
  status: { fontSize: 16, color: "#555", marginBottom: 16 },
  button: {
    backgroundColor: "#0a7",
    padding: 16,
    borderRadius: 8,
    alignItems: "center",
  },
  buttonSecondary: {
    backgroundColor: "#555",
    padding: 16,
    borderRadius: 8,
    alignItems: "center",
  },
  buttonText: { color: "white", fontSize: 18, fontWeight: "600" },
});
