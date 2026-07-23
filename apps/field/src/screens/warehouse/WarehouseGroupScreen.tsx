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
import { Pressable, ScrollView, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";

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
    <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 60, gap: 8 }}>
      <Text className="mb-1 text-lg font-bold text-foreground">{itemType} · {value || "(blank)"}</Text>

      {checkoutLookup ? (
        <CheckoutConfirmCard
          lookupResult={checkoutLookup}
          onCommit={(a, b) => void onCommit(a, b)}
          busy={checkoutBusy}
        />
      ) : null}

      {loading ? (
        <Text className="text-sm italic text-muted-foreground">Loading…</Text>
      ) : tags.length === 0 ? (
        <Text className="text-sm italic text-muted-foreground">No boxes in this group.</Text>
      ) : (
        tags.map((tag) => {
          const { prefix, tail } = splitEpc(tag.epc);
          return (
            <View key={tag.epc} className="rounded-lg border border-border bg-card p-3">
              <View className="flex-row items-center justify-between">
                <Text className="font-mono text-[13px] text-foreground">
                  <Text className="text-muted-foreground/60">{prefix}</Text>
                  <Text className="font-bold">{tail}</Text>
                </Text>
                <Text className="text-xs font-semibold text-muted-foreground">{tag.status}</Text>
              </View>
              <Text className="mt-0.5 text-xs text-muted-foreground">
                Item No. {tag.sku || "—"} · Mfc {tag.mfc_date || "—"}
              </Text>
              <Text className="mt-0.5 text-xs text-muted-foreground">
                {tag.remaining}/{tag.quantity} units · Bldg {tag.building || "n/a"} · BOL {tag.bol_number || "n/a"}
              </Text>
              {tag.flag ? <Text className="mt-1 text-xs font-semibold text-destructive">⚠ {tag.flag}</Text> : null}
              <View className="mt-2.5 flex-row gap-2">
                <Link href={{ pathname: "/finder", params: { epc: tag.epc } }} asChild>
                  <Button className="flex-1" variant="secondary">
                    <Text>Find</Text>
                  </Button>
                </Link>
                <Button className="flex-1" onPress={() => void onCheckOut(tag.epc)}>
                  <Text>Check Out</Text>
                </Button>
              </View>
            </View>
          );
        })
      )}
    </ScrollView>
  );
}
