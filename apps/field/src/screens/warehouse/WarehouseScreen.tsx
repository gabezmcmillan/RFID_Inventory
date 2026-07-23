/**
 * Warehouse browse screen (db.py:957-1064, app.py:284-297). A group-by toggle
 * (BOL / Building; named types always group by component name) plus the five
 * warehouse filters, feeding `inventoryTree`. Type headers show the type and
 * its unit total; each group row shows qty / capacity, boxes, vendors, the
 * other dimension's values, received date, a status chip, note count, and a
 * flagged-box badge, and links to the drill-down route. Export runs
 * `exportRows` → `exportCsv` → the iOS share sheet.
 */

import {
  BUILDING_OPTIONS,
  exportCsv,
  exportRows,
  inventoryTree,
  type InventoryFilters,
  type InventoryTreeResult,
} from "@rfid/domain";
import { useCallback, useEffect, useState } from "react";
import { Link } from "expo-router";
import { Pressable, ScrollView, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

import { useDb } from "../../db/provider";
import { shareCsv } from "./shareCsv";

type GroupBy = "bol" | "building";

/** Map a status string to a status-token background class. */
function statusClass(status: string): string {
  if (status === "In Warehouse") return "bg-status-in";
  if (status === "Partial") return "bg-status-partial";
  return "bg-status-delivered";
}

export function WarehouseScreen(): React.ReactNode {
  const db = useDb();
  const [groupBy, setGroupBy] = useState<GroupBy>("bol");
  const [filters, setFilters] = useState<InventoryFilters>({});
  const [tree, setTree] = useState<InventoryTreeResult | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setTree(await inventoryTree(db, groupBy, filters));
  }, [db, groupBy, filters]);

  useEffect(() => {
    void load();
  }, [load]);

  const onExport = async (): Promise<void> => {
    if (exporting) return;
    setExporting(true);
    setExportMsg(null);
    try {
      const rows = await exportRows(db, filters);
      await shareCsv(exportCsv(rows));
      setExportMsg(`Exported ${rows.length} box${rows.length === 1 ? "" : "es"}.`);
    } catch (err) {
      setExportMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 60, gap: 8 }}>
      <View className="mb-2 flex-row items-center justify-between">
        <View className="flex-row">
          <Pressable
            className={cn("rounded-md px-3.5 py-2", groupBy === "bol" ? "bg-brand-info" : "bg-muted")}
            onPress={() => setGroupBy("bol")}
          >
            <Text className={cn("text-sm font-semibold", groupBy === "bol" ? "text-white" : "text-foreground")}>BOL</Text>
          </Pressable>
          <Pressable
            className={cn("ml-1.5 rounded-md px-3.5 py-2", groupBy === "building" ? "bg-brand-info" : "bg-muted")}
            onPress={() => setGroupBy("building")}
          >
            <Text className={cn("text-sm font-semibold", groupBy === "building" ? "text-white" : "text-foreground")}>Building</Text>
          </Pressable>
        </View>
        <Button variant="secondary" onPress={() => setShowFilters((s) => !s)}>
          <Text>{showFilters ? "Hide filters" : "Filters"}</Text>
        </Button>
      </View>

      {showFilters ? (
        <FilterSheet filters={filters} onChange={setFilters} />
      ) : null}

      {tree?.types.length === 0 ? (
        <Text className="my-3 text-sm italic text-muted-foreground">No boxes match the current filters.</Text>
      ) : null}
      {tree?.types.map((t) => (
        <View key={t.item_type} className="mt-2">
          <Text className="mb-1 text-lg font-bold text-foreground">
            {t.item_type} — {t.qty} unit{t.qty === 1 ? "" : "s"}
          </Text>
          {t.groups.map((g) => (
            <Link
              key={g.value}
              href={{
                pathname: "/warehouse-group",
                params: { itemType: t.item_type, groupBy: t.named ? "name" : groupBy, value: g.value },
              }}
              asChild
            >
              <Pressable className="mb-1.5 rounded-lg border border-border bg-card p-3">
                <View className="flex-row items-center justify-between">
                  <Text className="text-base font-semibold text-foreground">{g.value || "(blank)"}</Text>
                  <View className={cn("rounded-full px-2 py-0.5", statusClass(g.status))}>
                    <Text className="text-[11px] font-bold text-white">{g.status}</Text>
                  </View>
                </View>
                <Text className="mt-1 text-xs text-muted-foreground">
                  {g.qty}/{g.total} units · {g.boxes} box{g.boxes === 1 ? "" : "es"}
                  {g.flagged > 0 ? ` · ⚠ ${g.flagged} flagged` : ""}
                  {g.note_count > 0 ? ` · ${g.note_count} note${g.note_count === 1 ? "" : "s"}` : ""}
                </Text>
                <Text className="mt-1 text-xs text-muted-foreground">
                  Received {g.received || "n/a"}
                  {g.vendors.length > 0 ? ` · ${g.vendors.join(", ")}` : ""}
                  {g.other_values.length > 0 ? ` · ${g.other_values.join(", ")}` : ""}
                </Text>
                {g.bol_doc_id ? (
                  <Link href={{ pathname: "/bol-docs", params: { docId: String(g.bol_doc_id) } }} asChild>
                    <Pressable className="mt-1.5 self-start rounded-md bg-brand-info/15 px-2 py-1">
                      <Text className="text-xs font-semibold text-brand-info">BOL document →</Text>
                    </Pressable>
                  </Link>
                ) : null}
              </Pressable>
            </Link>
          ))}
        </View>
      ))}

      <Button className="mt-3" disabled={exporting} onPress={() => void onExport()}>
        <Text className="text-base font-semibold">{exporting ? "Exporting…" : "Export CSV"}</Text>
      </Button>
      {exportMsg ? <Text className="mt-1.5 text-center text-[13px] text-muted-foreground">{exportMsg}</Text> : null}
    </ScrollView>
  );
}

/** The five warehouse filters: BOL substring, building, received from/to, checked-out from/to. */
function FilterSheet({
  filters,
  onChange,
}: {
  filters: InventoryFilters;
  onChange: (f: InventoryFilters) => void;
}): React.ReactNode {
  const set = (patch: Partial<InventoryFilters>): void => onChange({ ...filters, ...patch });
  return (
    <View className="mb-2 rounded-lg border border-border bg-muted/40 p-3">
      <Text className="mt-2 text-xs font-semibold text-foreground">BOL # (substring)</Text>
      <Input className="mt-1" value={filters.bol ?? ""} onChangeText={(v) => set({ bol: v })} placeholder="any" />

      <Text className="mt-2 text-xs font-semibold text-foreground">Building</Text>
      <View className="my-1 flex-row flex-wrap gap-1.5">
        <Pressable
          className={cn("rounded-md px-3 py-1.5", !filters.building ? "bg-brand-info" : "bg-muted")}
          onPress={() => set({ building: undefined })}
        >
          <Text className={cn("text-[13px]", !filters.building ? "text-white font-semibold" : "text-foreground")}>any</Text>
        </Pressable>
        {BUILDING_OPTIONS.map((opt) => (
          <Pressable
            key={opt}
            className={cn("rounded-md px-3 py-1.5", filters.building === opt ? "bg-brand-info" : "bg-muted")}
            onPress={() => set({ building: opt })}
          >
            <Text className={cn("text-[13px]", filters.building === opt ? "text-white font-semibold" : "text-foreground")}>{opt}</Text>
          </Pressable>
        ))}
      </View>

      <Text className="mt-2 text-xs font-semibold text-foreground">Received from / to (yyyy-mm-dd)</Text>
      <View className="mt-1 flex-row gap-2">
        <Input className="flex-1" value={filters.received_from ?? ""} onChangeText={(v) => set({ received_from: v })} placeholder="from" />
        <Input className="flex-1" value={filters.received_to ?? ""} onChangeText={(v) => set({ received_to: v })} placeholder="to" />
      </View>

      <Text className="mt-2 text-xs font-semibold text-foreground">Checked out from / to (yyyy-mm-dd)</Text>
      <View className="mt-1 flex-row gap-2">
        <Input className="flex-1" value={filters.checked_out_from ?? ""} onChangeText={(v) => set({ checked_out_from: v })} placeholder="from" />
        <Input className="flex-1" value={filters.checked_out_to ?? ""} onChangeText={(v) => set({ checked_out_to: v })} placeholder="to" />
      </View>
    </View>
  );
}
