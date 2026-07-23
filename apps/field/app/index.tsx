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
import { Pressable, View } from "react-native";

import { Badge } from "@/components/ui/badge";
import { Text } from "@/components/ui/text";

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
    <View className="flex-1 p-5 gap-3">
      <Text variant="h1" className="mt-3 text-left">RFID Field</Text>
      <Text className="text-sm text-muted-foreground mb-2">
        Reader: {connected ? "connected" : "disconnected"}
      </Text>
      <View className="flex-row flex-wrap gap-2.5">
        {MODES.map((m) => (
          <Link key={m.href} href={m.href} asChild>
            {/* Slot (asChild) needs a single resolvable style; NativeWind
                collapses className + the inline accent style into one. */}
            <Pressable
              className="w-[47%] flex-grow rounded-lg border-2 bg-card p-4"
              style={{ borderColor: m.accent }}
            >
              <Text className="text-lg font-bold mb-1" style={{ color: m.accent }}>{m.title}</Text>
              <Text className="text-sm text-muted-foreground">{m.subtitle}</Text>
            </Pressable>
          </Link>
        ))}
        <Link href="/requests" asChild>
          <Pressable
            className="w-[47%] flex-grow rounded-lg border-2 bg-card p-4"
            style={{ borderColor: REQUESTS_ACCENT }}
          >
            <Text className="text-lg font-bold mb-1" style={{ color: REQUESTS_ACCENT }}>Requests</Text>
            <Text className="text-sm text-muted-foreground">Open material requests</Text>
            {openCount > 0 ? (
              <Badge variant="destructive" className="absolute right-2 top-2">
                {openCount}
              </Badge>
            ) : null}
          </Pressable>
        </Link>
      </View>
    </View>
  );
}
