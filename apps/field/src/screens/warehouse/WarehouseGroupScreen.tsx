/**
 * Warehouse drill-down (db.py:1066-1083, app.py:386-400): the individual boxes
 * in one (item_type, group) cell, via `groupTags`. Each row shows the EPC (last
 * 6 chars emphasized), Item No., mfc date, remaining/quantity, status, and
 * flag, with **Find** (→ `/finder?epc=…`) and **Check Out** (opens
 * {@link CheckoutConfirmCard} with a direct `lookupForCheckout`, no trigger
 * needed).
 */

import { groupTags, lookupForCheckout, deliverUnits, type LookupForCheckoutResult, type Tag } from "@rfid/domain";
import { useEffect, useState } from "react";
import { Link, useLocalSearchParams } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { useDb } from "../../db/provider";
import { CheckoutConfirmCard } from "../checkout/CheckoutConfirmCard";

/** Split an EPC into a dim prefix and the emphasized last 6 hex chars. */
function splitEpc(epc: string): { prefix: string; tail: string } {
  return { prefix: epc.slice(0, Math.max(0, epc.length - 6)), tail: epc.slice(-6) };
}

export function WarehouseGroupScreen(): React.ReactNode {
  const db = useDb();
  const params = useLocalSearchParams<{ itemType: string; groupBy: string; value: string }>();
  const itemType = params.itemType ?? "";
  const groupBy = params.groupBy ?? "bol";
  const value = params.value ?? "";

  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [checkoutLookup, setCheckoutLookup] = useState<LookupForCheckoutResult | null>(null);
  const [checkoutBusy, setCheckoutBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const result = await groupTags(db, itemType, groupBy, value);
      if (!cancelled) {
        setTags(result.tags);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [db, itemType, groupBy, value]);

  const onCheckOut = async (epc: string): Promise<void> => {
    setCheckoutLookup(await lookupForCheckout(db, epc));
  };

  const onCommit = async (amount: number, building: string): Promise<void> => {
    if (!checkoutLookup || checkoutBusy || !checkoutLookup.ok) return;
    setCheckoutBusy(true);
    try {
      await deliverUnits(db, checkoutLookup.epc, amount, building || null);
      setCheckoutLookup(null);
      // Refresh the drill-down so the row's remaining/status reflects the draw.
      const result = await groupTags(db, itemType, groupBy, value);
      setTags(result.tags);
    } finally {
      setCheckoutBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>{itemType} · {value || "(blank)"}</Text>

      {checkoutLookup ? (
        <CheckoutConfirmCard
          lookupResult={checkoutLookup}
          onCommit={(a, b) => void onCommit(a, b)}
          busy={checkoutBusy}
        />
      ) : null}

      {loading ? (
        <Text style={styles.hint}>Loading…</Text>
      ) : tags.length === 0 ? (
        <Text style={styles.hint}>No boxes in this group.</Text>
      ) : (
        tags.map((tag) => {
          const { prefix, tail } = splitEpc(tag.epc);
          return (
            <View key={tag.epc} style={styles.boxCard}>
              <View style={styles.boxHead}>
                <Text style={styles.epc}>
                  <Text style={styles.epcPrefix}>{prefix}</Text>
                  <Text style={styles.epcTail}>{tail}</Text>
                </Text>
                <Text style={styles.status}>{tag.status}</Text>
              </View>
              <Text style={styles.meta}>
                Item No. {tag.sku || "—"} · Mfc {tag.mfc_date || "—"}
              </Text>
              <Text style={styles.meta}>
                {tag.remaining}/{tag.quantity} units · Bldg {tag.building || "n/a"} · BOL {tag.bol_number || "n/a"}
              </Text>
              {tag.flag ? <Text style={styles.flag}>⚠ {tag.flag}</Text> : null}
              <View style={styles.btnRow}>
                <Link href={{ pathname: "/finder", params: { epc: tag.epc } }} asChild>
                  {/* Slot (asChild) rejects array styles — flatten to one object. */}
                  <Pressable style={StyleSheet.flatten([styles.btn, styles.btnFind])}>
                    <Text style={styles.btnText}>Find</Text>
                  </Pressable>
                </Link>
                <Pressable style={[styles.btn, styles.btnCheckOut]} onPress={() => void onCheckOut(tag.epc)}>
                  <Text style={styles.btnText}>Check Out</Text>
                </Pressable>
              </View>
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingBottom: 60, gap: 8 },
  title: { fontSize: 18, fontWeight: "bold", marginBottom: 4 },
  hint: { color: "#888", fontStyle: "italic" },
  boxCard: { borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 12, backgroundColor: "white" },
  boxHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  epc: { fontFamily: "monospace", fontSize: 13 },
  epcPrefix: { color: "#999" },
  epcTail: { color: "#222", fontWeight: "bold" },
  status: { fontSize: 12, fontWeight: "600", color: "#555" },
  meta: { fontSize: 12, color: "#666", marginTop: 3 },
  flag: { color: "#c33", fontWeight: "600", fontSize: 12, marginTop: 4 },
  btnRow: { flexDirection: "row", gap: 8, marginTop: 10 },
  btn: { flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: "center" },
  btnFind: { backgroundColor: "#06c" },
  btnCheckOut: { backgroundColor: "#0a7" },
  btnText: { color: "white", fontWeight: "600" },
});
