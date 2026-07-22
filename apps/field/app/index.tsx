/**
 * Mode home — the landing screen. A grid of cards for every operator mode,
 * each linking to its route. Find a Tag is entered from a warehouse box row
 * (it needs a target EPC), so it has no home card. Requests (plan 008) is the
 * one remaining placeholder. The reader stays idle here.
 */

import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { readerService } from "../src/reader/readerService";

interface ModeCard {
  readonly href: string;
  readonly title: string;
  readonly subtitle: string;
  readonly accent: string;
}

const MODES: readonly ModeCard[] = [
  { href: "/check-in", title: "Check In", subtitle: "Arm a shipment, scan tags in", accent: "#0a7" },
  { href: "/check-out", title: "Check Out", subtitle: "Draw units out for site", accent: "#06c" },
  { href: "/sweep", title: "Sweep & Count", subtitle: "Audit what's present", accent: "#7c5" },
  { href: "/warehouse", title: "Warehouse", subtitle: "Browse & find boxes", accent: "#a06" },
  { href: "/bol-docs", title: "BOL Docs", subtitle: "Scanned bills of lading", accent: "#36c" },
  { href: "/events", title: "Event Log", subtitle: "Audit trail", accent: "#555" },
  { href: "/admin", title: "Admin", subtitle: "PIN-gated tools", accent: "#c63" },
  { href: "/settings", title: "Settings", subtitle: "Reader, printer, cloud", accent: "#444" },
  { href: "/dev-tools", title: "Dev Tools", subtitle: "Inject scans", accent: "#999" },
];

export default function HomeScreen(): React.ReactNode {
  const [connected, setConnected] = useState(readerService.connected);
  useEffect(() => {
    const unsub = readerService.subscribe((e) => {
      if (e.event === "status") setConnected(e.connected);
    });
    // Home keeps the reader idle between modes.
    readerService.setMode("idle");
    return unsub;
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>RFID Field</Text>
      <Text style={styles.status}>
        Reader: {connected ? "connected" : "disconnected"}
      </Text>
      <View style={styles.grid}>
        {MODES.map((m) => (
          <Link key={m.href} href={m.href} asChild>
            {/* Slot (asChild) rejects array styles — flatten to one object. */}
            <Pressable style={StyleSheet.flatten([styles.card, { borderColor: m.accent }])}>
              <Text style={[styles.cardTitle, { color: m.accent }]}>{m.title}</Text>
              <Text style={styles.cardSubtitle}>{m.subtitle}</Text>
            </Pressable>
          </Link>
        ))}
        <View style={[styles.card, styles.cardPlaceholder]}>
          <Text style={styles.cardTitle}>Requests</Text>
          <Text style={styles.cardSubtitle}>coming soon</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 12 },
  title: { fontSize: 28, fontWeight: "bold", marginTop: 12 },
  status: { fontSize: 14, color: "#777", marginBottom: 8 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  card: { width: "47%", flexGrow: 1, borderWidth: 2, borderRadius: 10, padding: 16, backgroundColor: "white" },
  cardPlaceholder: { borderColor: "#ddd", backgroundColor: "#f6f6f6" },
  cardTitle: { fontSize: 18, fontWeight: "bold", marginBottom: 4 },
  cardSubtitle: { fontSize: 13, color: "#777" },
});
