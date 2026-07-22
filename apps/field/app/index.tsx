/**
 * Mode home — the landing screen. A grid of cards for every operator mode,
 * each linking to its route. Find a Tag is entered from a warehouse box row
 * (it needs a target EPC), so it has no home card. The Requests card carries a
 * `countOpenRequests` badge that refreshes on mount and whenever a request is
 * mutated on any screen (see `screens/requests/refresh`). The reader stays
 * idle here.
 */

import { countOpenRequests } from "@rfid/domain";
import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useDb } from "../src/db/provider";
import { readerService } from "../src/reader/readerService";
import { subscribeRequestsChanged } from "../src/screens/requests/refresh";

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

const REQUESTS_ACCENT = "#06c";

export default function HomeScreen(): React.ReactNode {
  const db = useDb();
  const [connected, setConnected] = useState(readerService.connected);
  const [openCount, setOpenCount] = useState(0);

  useEffect(() => {
    const unsub = readerService.subscribe((e) => {
      if (e.event === "status") setConnected(e.connected);
    });
    // Home keeps the reader idle between modes.
    readerService.setMode("idle");
    return unsub;
  }, []);

  // Load the open-request badge once and whenever any request mutates.
  useEffect(() => {
    const load = async (): Promise<void> => setOpenCount(await countOpenRequests(db));
    void load();
    return subscribeRequestsChanged(() => void load());
  }, [db]);

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
        <Link href="/requests" asChild>
          {/* Slot (asChild) rejects array styles — flatten to one object. */}
          <Pressable style={StyleSheet.flatten([styles.card, { borderColor: REQUESTS_ACCENT }])}>
            <Text style={[styles.cardTitle, { color: REQUESTS_ACCENT }]}>Requests</Text>
            <Text style={styles.cardSubtitle}>Open material requests</Text>
            {openCount > 0 ? (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{openCount}</Text>
              </View>
            ) : null}
          </Pressable>
        </Link>
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
  cardTitle: { fontSize: 18, fontWeight: "bold", marginBottom: 4 },
  cardSubtitle: { fontSize: 13, color: "#777" },
  badge: { position: "absolute", top: 8, right: 8, minWidth: 22, height: 22, paddingHorizontal: 6, borderRadius: 11, backgroundColor: "#c33", alignItems: "center", justifyContent: "center" },
  badgeText: { color: "white", fontWeight: "700", fontSize: 13 },
});
