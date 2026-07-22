/**
 * Check Out screen — the two-step drawdown (db.py:744-857, app.py:196-203).
 * A trigger pull only looks the box up (`lookupForCheckout`); the
 * {@link CheckoutConfirmCard} then collects an amount + destination and the
 * screen commits via `deliverUnits`, appending a result row (with a mismatch
 * banner when the destination differs from the received building). Reader
 * runs `checkout` while focused and returns to `idle` on blur.
 */

import {
  deliverUnits,
  lookupForCheckout,
  type DeliverUnitsResult,
  type LookupForCheckoutResult,
} from "@rfid/domain";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { useDb } from "../../db/provider";
import { useReaderEvents } from "../../hooks/useReaderEvents";
import { readerService } from "../../reader/readerService";
import { CheckoutConfirmCard } from "./CheckoutConfirmCard";

/** One entry in the checkout result log: a commit result or a lookup error. */
interface CheckoutResultEntry {
  readonly epc: string;
  readonly result: DeliverUnitsResult | { readonly ok: false; readonly message: string };
}

/** A 24-hex EPC for the dev "simulate scan" button. */
function randomEpc(): string {
  const hex = "0123456789ABCDEF";
  let s = "";
  for (let i = 0; i < 24; i++) s += hex[Math.floor(Math.random() * 16)];
  return s;
}

export function CheckOutScreen(): React.ReactNode {
  const db = useDb();
  const [lookup, setLookup] = useState<LookupForCheckoutResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<CheckoutResultEntry[]>([]);

  // Scan handler: look the box up. ok → show the confirm card; !ok → error row.
  useReaderEvents((event) => {
    if (event.event !== "scan" || event.mode !== "checkout") return;
    void (async () => {
      const result = await lookupForCheckout(db, event.epc);
      if (result.ok) {
        setLookup(result);
      } else {
        setLookup(null);
        setResults((prev) => [
          ...prev,
          { epc: event.epc, result: { ok: false, message: result.message ?? `${event.epc} not registered.` } },
        ]);
      }
    })();
  });

  // Arm `checkout` on focus; return the reader to `idle` on blur (app.py:944-947).
  useEffect(() => {
    readerService.setMode("checkout");
    return () => {
      readerService.setMode("idle");
    };
  }, []);

  const onCommit = async (amount: number, building: string): Promise<void> => {
    if (!lookup || busy) return;
    setBusy(true);
    try {
      const result = await deliverUnits(db, lookup.epc, amount, building || null);
      setResults((prev) => [...prev, { epc: lookup.epc, result }]);
      setLookup(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.hint}>Pull the trigger on a box to look it up for check-out…</Text>

      {lookup ? (
        <CheckoutConfirmCard lookupResult={lookup} onCommit={(a, b) => void onCommit(a, b)} busy={busy} />
      ) : null}

      {results.length === 0 ? null : (
        <View style={styles.results}>
          {results.map((entry, i) => (
            <ResultRow key={`${entry.epc}-${i}`} entry={entry} />
          ))}
        </View>
      )}

      {__DEV__ ? (
        <Pressable style={styles.simBtn} onPress={() => readerService.injectScan([randomEpc()])}>
          <Text style={styles.simBtnText}>Simulate scan</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

/** One checkout result row: the message, EPC, and a red mismatch banner. */
function ResultRow({ entry }: { entry: CheckoutResultEntry }): React.ReactNode {
  const { result } = entry;
  const message = result.message;
  const flag = "flag" in result && result.flag ? result.flag : null;
  return (
    <View style={styles.card}>
      <Text style={[styles.message, !result.ok && styles.messageError]}>{message}</Text>
      <Text style={styles.meta}>EPC: {entry.epc}</Text>
      {flag ? <Text style={styles.flagBanner}>⚠ {flag}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingBottom: 60, gap: 10 },
  hint: { color: "#888", fontStyle: "italic", marginBottom: 4 },
  results: { marginTop: 8, gap: 8 },
  card: { borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 12, backgroundColor: "white" },
  message: { fontSize: 15, fontWeight: "600", color: "#222" },
  messageError: { color: "#c33" },
  meta: { fontSize: 12, color: "#666", marginTop: 4 },
  flagBanner: { marginTop: 6, color: "#c33", fontWeight: "600", fontSize: 13 },
  simBtn: { backgroundColor: "#eee", padding: 12, borderRadius: 8, alignItems: "center", marginTop: 16 },
  simBtnText: { color: "#333", fontWeight: "600" },
});
