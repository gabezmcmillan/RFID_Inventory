/**
 * Mode home — the landing screen. A grid of tiles for every operator mode,
 * each linking to its route. Find a Tag is entered from a warehouse box row
 * (it needs a target EPC), so it has no home tile. The Requests tile carries a
 * `countOpenRequests` badge that refreshes on mount and whenever a request is
 * mutated on any screen (see `screens/requests/refresh`). The reader stays
 * idle here. The SyncStatusBanner renders above this screen from the
 * SyncProvider; the reader connection chip here gives a glanceable hardware
 * status.
 */

import { countOpenRequests } from "@rfid/domain";
import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import {
  Boxes,
  ClipboardList,
  FileText,
  History,
  PackageCheck,
  PackageMinus,
  Radar,
  Settings as SettingsIcon,
  ShieldCheck,
  Terminal,
  type LucideIcon,
} from "lucide-react-native";

import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";

import { useDb } from "../src/db/provider";
import { readerService } from "../src/reader/readerService";
import { subscribeRequestsChanged } from "../src/screens/requests/refresh";

interface ModeTile {
  readonly href: string;
  readonly title: string;
  readonly subtitle: string;
  readonly icon: LucideIcon;
}

const MODES: readonly ModeTile[] = [
  { href: "/check-in", title: "Check In", subtitle: "Arm a shipment, scan tags in", icon: PackageCheck },
  { href: "/check-out", title: "Check Out", subtitle: "Draw units out for site", icon: PackageMinus },
  { href: "/sweep", title: "Sweep & Count", subtitle: "Audit what's present", icon: Radar },
  { href: "/warehouse", title: "Warehouse", subtitle: "Browse & find boxes", icon: Boxes },
  { href: "/bol-docs", title: "BOL Docs", subtitle: "Scanned bills of lading", icon: FileText },
  { href: "/events", title: "Event Log", subtitle: "Audit trail", icon: History },
  { href: "/admin", title: "Admin", subtitle: "PIN-gated tools", icon: ShieldCheck },
  { href: "/settings", title: "Settings", subtitle: "Reader, printer, cloud", icon: SettingsIcon },
  { href: "/dev-tools", title: "Dev Tools", subtitle: "Inject scans", icon: Terminal },
];

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
    <View className="flex-1 px-5 pt-2">
      <View className="flex-row items-center justify-between pb-3">
        <Text className="text-3xl font-extrabold tracking-tight text-brand-navy">RFID Field</Text>
        <View
          className={`flex-row items-center gap-1.5 rounded-full px-3 py-1.5 ${
            connected ? "bg-status-in/15" : "bg-muted"
          }`}
        >
          <View className={`h-2 w-2 rounded-full ${connected ? "bg-status-in" : "bg-muted-foreground"}`} />
          <Text className={`text-xs font-semibold ${connected ? "text-status-in" : "text-muted-foreground"}`}>
            {connected ? "Reader connected" : "Reader off"}
          </Text>
        </View>
      </View>

      <View className="flex-row flex-wrap gap-3">
        {MODES.map((m) => (
          <Link key={m.href} href={m.href} asChild>
            <Pressable className="w-[47%] flex-grow rounded-2xl border border-border bg-card p-4 active:opacity-70">
              <View className="mb-2 h-11 w-11 items-center justify-center rounded-xl bg-brand-navy/10">
                <Icon as={m.icon} size={22} className="text-brand-navy" />
              </View>
              <Text className="text-lg font-bold text-foreground">{m.title}</Text>
              <Text className="mt-0.5 text-sm leading-snug text-muted-foreground">{m.subtitle}</Text>
            </Pressable>
          </Link>
        ))}
        <Link href="/requests" asChild>
          <Pressable className="relative w-[47%] flex-grow rounded-2xl border border-border bg-card p-4 active:opacity-70">
            <View className="mb-2 h-11 w-11 items-center justify-center rounded-xl bg-brand-info/15">
              <Icon as={ClipboardList} size={22} className="text-brand-info" />
            </View>
            <Text className="text-lg font-bold text-foreground">Requests</Text>
            <Text className="mt-0.5 text-sm leading-snug text-muted-foreground">Open material requests</Text>
            {openCount > 0 ? (
              <Badge variant="destructive" className="absolute right-2.5 top-2.5">
                {openCount}
              </Badge>
            ) : null}
          </Pressable>
        </Link>
      </View>
    </View>
  );
}
