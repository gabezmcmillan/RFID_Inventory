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
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

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
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.summary}>
        <Text style={styles.summaryNum}>{distinct}</Text>
        <Text style={styles.summaryLabel}>distinct tags · {totalUnits} units counted</Text>
      </View>

      <Pressable style={styles.simBtn} onPress={() => readerService.injectScan([randomEpc()])}>
        <Text style={styles.simBtnText}>Simulate scan</Text>
      </Pressable>

      <Text style={styles.sectionLabel}>Counts by type</Text>
      {Object.keys(counts).length === 0 ? (
        <Text style={styles.hint}>No tags scanned yet.</Text>
      ) : (
        Object.entries(counts).map(([type, n]) => (
          <View key={type} style={styles.countRow}>
            <Text style={styles.countType}>{type}</Text>
            <Text style={styles.countNum}>{n} units</Text>
          </View>
        ))
      )}

      <Text style={styles.sectionLabel}>Unknown ({unknown.length})</Text>
      {unknown.length === 0 ? (
        <Text style={styles.hint}>None.</Text>
      ) : (
        unknown.map((e) => <Text key={e} style={styles.mono}>{e}</Text>)
      )}

      <Text style={styles.sectionLabel}>Flagged ({flagged.length})</Text>
      {flagged.length === 0 ? (
        <Text style={styles.hint}>None.</Text>
      ) : (
        flagged.map((f) => (
          <View key={f.epc} style={styles.flagCard}>
            <Text style={styles.flagText}>⚠ {f.flag}</Text>
            <Text style={styles.meta}>{f.item_type} · BOL {f.bol_number || "n/a"} · Bldg {f.building || "n/a"}</Text>
            <Text style={styles.mono}>{f.epc}</Text>
          </View>
        ))
      )}

      <View style={styles.actionRow}>
        <Pressable style={[styles.btn, styles.btnPrimary, busy && styles.btnDisabled]} disabled={busy} onPress={() => void onReconcile()}>
          <Text style={styles.btnText}>{busy ? "…" : "Reconcile"}</Text>
        </Pressable>
        <Pressable style={[styles.btn, styles.btnSecondary]} onPress={newSession}>
          <Text style={styles.btnText}>New session</Text>
        </Pressable>
      </View>

      {reconcile ? (
        <View style={styles.reconcileCard}>
          <Text style={styles.reconcileTitle}>Reconciliation</Text>
          <Text style={styles.meta}>
            Expected {reconcile.expected} · Found {reconcile.found_count} · Missing {reconcile.missing_count}
          </Text>
          {reconcile.missing.length === 0 ? (
            <Text style={styles.hint}>Nothing missing.</Text>
          ) : (
            reconcile.missing.map((m) => (
              <View key={m.epc} style={styles.missingRow}>
                <Text style={styles.mono}>{m.epc}</Text>
                <Text style={styles.meta}>{m.item_type} · BOL {m.bol_number || "n/a"} · Bldg {m.building || "n/a"}</Text>
              </View>
            ))
          )}
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingBottom: 60, gap: 6 },
  summary: { flexDirection: "row", alignItems: "baseline", gap: 10, marginBottom: 8 },
  summaryNum: { fontSize: 32, fontWeight: "bold" },
  summaryLabel: { fontSize: 14, color: "#555" },
  simBtn: { backgroundColor: "#eee", padding: 12, borderRadius: 8, alignItems: "center", marginBottom: 8 },
  simBtnText: { color: "#333", fontWeight: "600" },
  sectionLabel: { fontSize: 14, fontWeight: "600", marginTop: 12, marginBottom: 4, color: "#333" },
  hint: { color: "#888", fontStyle: "italic" },
  countRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  countType: { fontSize: 16, fontWeight: "600" },
  countNum: { fontSize: 16 },
  mono: { fontFamily: "monospace", fontSize: 12, color: "#444" },
  flagCard: { borderWidth: 1, borderColor: "#c33", borderRadius: 6, padding: 10, backgroundColor: "#fdecea", marginVertical: 4 },
  flagText: { color: "#c33", fontWeight: "600", fontSize: 13 },
  meta: { fontSize: 12, color: "#666", marginTop: 2 },
  actionRow: { flexDirection: "row", gap: 10, marginTop: 16 },
  btn: { flex: 1, padding: 14, borderRadius: 8, alignItems: "center" },
  btnPrimary: { backgroundColor: "#0a7" },
  btnSecondary: { backgroundColor: "#555" },
  btnDisabled: { backgroundColor: "#9ab" },
  btnText: { color: "white", fontWeight: "600" },
  reconcileCard: { borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 12, backgroundColor: "white", marginTop: 12 },
  reconcileTitle: { fontSize: 16, fontWeight: "bold", marginBottom: 4 },
  missingRow: { paddingVertical: 6, borderTopWidth: 1, borderTopColor: "#eee" },
});
