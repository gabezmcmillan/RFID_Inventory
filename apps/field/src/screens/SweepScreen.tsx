/**
 * Sweep & Count screen (db.py:859-923, app.py:205-211). Each trigger-hold
 * produces an `inventory` event with the burst's distinct EPCs; the screen
 * calls `recordInventory` with just that burst (the DB logs `COUNT` per burst
 * for the audit trail) and accumulates the EPCs into a session set held in a
 * ref. The display aggregates per-type unit counts, the distinct-tag total,
 * the unknown list, and the flagged-ghost list (red) — each EPC counted once,
 * even if scanned in several bursts. "Reconcile" runs `compareInventory` over
 * the session set; "New session" clears it. Read-only for quantities.
 */

import {
  compareInventory,
  recordInventory,
  type CompareInventoryResult,
  type FlaggedTag,
} from "@rfid/domain";
import { useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";

import { useDb } from "../db/provider";
import { useReaderEvents } from "../hooks/useReaderEvents";
import { readerService } from "../reader/readerService";

/** A 24-hex EPC for the dev "simulate scan" button. */
function randomEpc(): string {
  const hex = "0123456789ABCDEF";
  let s = "";
  for (let i = 0; i < 24; i++) s += hex[Math.floor(Math.random() * 16)];
  return s;
}

export function SweepScreen(): React.ReactNode {
  const db = useDb();
  // Session set in a ref: accumulates EPCs across bursts for reconciliation,
  // without forcing a re-render on every merge.
  const sessionEpcs = useRef<Set<string>>(new Set());

  const [counts, setCounts] = useState<Record<string, number>>({});
  const [distinct, setDistinct] = useState(0);
  const [unknown, setUnknown] = useState<string[]>([]);
  const [flagged, setFlagged] = useState<FlaggedTag[]>([]);
  const [reconcile, setReconcile] = useState<CompareInventoryResult | null>(null);
  const [busy, setBusy] = useState(false);

  // Each inventory burst: log it (recordInventory) and merge the new EPCs.
  useReaderEvents((event) => {
    if (event.event !== "inventory") return;
    void (async () => {
      const burst = [...event.epcs];
      const seen = sessionEpcs.current;
      const newSet = new Set(burst.filter((e) => !seen.has(e)));
      for (const e of burst) seen.add(e);
      setDistinct(seen.size);

      const result = await recordInventory(db, burst);

      // Aggregate, counting each EPC only once (the first burst it appears in).
      const countsDelta: Record<string, number> = {};
      for (const item of result.items) {
        if (newSet.has(item.epc)) {
          countsDelta[item.item_type] = (countsDelta[item.item_type] ?? 0) + item.remaining;
        }
      }
      const newUnknown = result.unknown.filter((u) => newSet.has(u));
      const newFlagged = result.flagged.filter((f) => newSet.has(f.epc));

      setCounts((prev) => {
        const next = { ...prev };
        for (const [type, delta] of Object.entries(countsDelta)) {
          next[type] = (next[type] ?? 0) + delta;
        }
        return next;
      });
      if (newUnknown.length > 0) setUnknown((prev) => [...prev, ...newUnknown]);
      if (newFlagged.length > 0) setFlagged((prev) => [...prev, ...newFlagged]);
    })();
  });

  // Arm `inventory` on focus; return the reader to `idle` on blur (app.py:944-947).
  useEffect(() => {
    readerService.setMode("inventory");
    return () => {
      readerService.setMode("idle");
    };
  }, []);

  const onReconcile = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await compareInventory(db, [...sessionEpcs.current]);
      setReconcile(result);
    } finally {
      setBusy(false);
    }
  };

  const newSession = (): void => {
    sessionEpcs.current = new Set();
    setCounts({});
    setDistinct(0);
    setUnknown([]);
    setFlagged([]);
    setReconcile(null);
  };

  const totalUnits = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 60, gap: 6 }}>
      <View className="mb-2 flex-row items-baseline gap-2.5">
        <Text className="text-[32px] font-bold text-foreground">{distinct}</Text>
        <Text className="text-sm text-muted-foreground">distinct tags · {totalUnits} units counted</Text>
      </View>

      <Button variant="secondary" className="mb-2" onPress={() => readerService.injectScan([randomEpc()])}>
        <Text>Simulate scan</Text>
      </Button>

      <Text className="mb-1 mt-3 text-sm font-semibold text-foreground">Counts by type</Text>
      {Object.keys(counts).length === 0 ? (
        <Text className="text-sm italic text-muted-foreground">No tags scanned yet.</Text>
      ) : (
        Object.entries(counts).map(([type, n]) => (
          <View key={type} className="flex-row justify-between py-1">
            <Text className="text-base font-semibold text-foreground">{type}</Text>
            <Text className="text-base text-foreground">{n} units</Text>
          </View>
        ))
      )}

      <Text className="mb-1 mt-3 text-sm font-semibold text-foreground">Unknown ({unknown.length})</Text>
      {unknown.length === 0 ? (
        <Text className="text-sm italic text-muted-foreground">None.</Text>
      ) : (
        unknown.map((e) => <Text key={e} className="font-mono text-xs text-muted-foreground">{e}</Text>)
      )}

      <Text className="mb-1 mt-3 text-sm font-semibold text-foreground">Flagged ({flagged.length})</Text>
      {flagged.length === 0 ? (
        <Text className="text-sm italic text-muted-foreground">None.</Text>
      ) : (
        flagged.map((f) => (
          <View key={f.epc} className="my-1 rounded-md border border-destructive bg-destructive/10 p-2.5">
            <Text className="text-[13px] font-semibold text-destructive">⚠ {f.flag}</Text>
            <Text className="mt-0.5 text-xs text-muted-foreground">{f.item_type} · BOL {f.bol_number || "n/a"} · Bldg {f.building || "n/a"}</Text>
            <Text className="font-mono text-xs text-muted-foreground">{f.epc}</Text>
          </View>
        ))
      )}

      <View className="mt-4 flex-row gap-2.5">
        <Button className="flex-1" disabled={busy} onPress={() => void onReconcile()}>
          <Text className="font-semibold">{busy ? "…" : "Reconcile"}</Text>
        </Button>
        <Button className="flex-1" variant="secondary" onPress={newSession}>
          <Text className="font-semibold">New session</Text>
        </Button>
      </View>

      {reconcile ? (
        <View className="mt-3 rounded-lg border border-border bg-card p-3">
          <Text className="mb-1 text-base font-bold text-foreground">Reconciliation</Text>
          <Text className="text-xs text-muted-foreground">
            Expected {reconcile.expected} · Found {reconcile.found_count} · Missing {reconcile.missing_count}
          </Text>
          {reconcile.missing.length === 0 ? (
            <Text className="text-sm italic text-muted-foreground">Nothing missing.</Text>
          ) : (
            reconcile.missing.map((m) => (
              <View key={m.epc} className="border-t border-border py-1.5">
                <Text className="font-mono text-xs text-muted-foreground">{m.epc}</Text>
                <Text className="text-xs text-muted-foreground">{m.item_type} · BOL {m.bol_number || "n/a"} · Bldg {m.building || "n/a"}</Text>
              </View>
            ))
          )}
        </View>
      ) : null}
    </ScrollView>
  );
}
