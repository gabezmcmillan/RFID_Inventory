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
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { useDb } from "../../db/provider";
import { shareCsv } from "./shareCsv";

type GroupBy = "bol" | "building";

const STATUS_COLORS: Record<string, string> = {
  "In Warehouse": "#0a7",
  Partial: "#e6a700",
  Delivered: "#888",
};

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
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.topRow}>
        <View style={styles.toggle}>
          <Pressable
            style={[styles.toggleBtn, groupBy === "bol" && styles.toggleBtnActive]}
            onPress={() => setGroupBy("bol")}
          >
            <Text style={[styles.toggleText, groupBy === "bol" && styles.toggleTextActive]}>BOL</Text>
          </Pressable>
          <Pressable
            style={[styles.toggleBtn, groupBy === "building" && styles.toggleBtnActive]}
            onPress={() => setGroupBy("building")}
          >
            <Text style={[styles.toggleText, groupBy === "building" && styles.toggleTextActive]}>Building</Text>
          </Pressable>
        </View>
        <Pressable style={styles.filterBtn} onPress={() => setShowFilters((s) => !s)}>
          <Text style={styles.filterBtnText}>{showFilters ? "Hide filters" : "Filters"}</Text>
        </Pressable>
      </View>

      {showFilters ? (
        <FilterSheet filters={filters} onChange={setFilters} />
      ) : null}

      {tree?.types.length === 0 ? (
        <Text style={styles.hint}>No boxes match the current filters.</Text>
      ) : null}
      {tree?.types.map((t) => (
        <View key={t.item_type} style={styles.typeBlock}>
          <Text style={styles.typeHeader}>
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
              <Pressable style={styles.groupRow}>
                <View style={styles.groupHead}>
                  <Text style={styles.groupValue}>{g.value || "(blank)"}</Text>
                  <View style={[styles.statusChip, { backgroundColor: STATUS_COLORS[g.status] ?? "#888" }]}>
                    <Text style={styles.statusChipText}>{g.status}</Text>
                  </View>
                </View>
                <Text style={styles.groupMeta}>
                  {g.qty}/{g.total} units · {g.boxes} box{g.boxes === 1 ? "" : "es"}
                  {g.flagged > 0 ? ` · ⚠ ${g.flagged} flagged` : ""}
                  {g.note_count > 0 ? ` · ${g.note_count} note${g.note_count === 1 ? "" : "s"}` : ""}
                </Text>
                <Text style={styles.groupMeta}>
                  Received {g.received || "n/a"}
                  {g.vendors.length > 0 ? ` · ${g.vendors.join(", ")}` : ""}
                  {g.other_values.length > 0 ? ` · ${g.other_values.join(", ")}` : ""}
                </Text>
              </Pressable>
            </Link>
          ))}
        </View>
      ))}

      <Pressable style={[styles.exportBtn, exporting && styles.exportBtnDisabled]} disabled={exporting} onPress={() => void onExport()}>
        <Text style={styles.exportBtnText}>{exporting ? "Exporting…" : "Export CSV"}</Text>
      </Pressable>
      {exportMsg ? <Text style={styles.exportMsg}>{exportMsg}</Text> : null}
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
    <View style={styles.filterSheet}>
      <Text style={styles.filterLabel}>BOL # (substring)</Text>
      <TextInput style={styles.input} value={filters.bol ?? ""} onChangeText={(v) => set({ bol: v })} placeholder="any" />

      <Text style={styles.filterLabel}>Building</Text>
      <View style={styles.chips}>
        <Pressable
          style={[styles.chip, !filters.building && styles.chipActive]}
          onPress={() => set({ building: undefined })}
        >
          <Text style={[styles.chipText, !filters.building && styles.chipTextActive]}>any</Text>
        </Pressable>
        {BUILDING_OPTIONS.map((opt) => (
          <Pressable
            key={opt}
            style={[styles.chip, filters.building === opt && styles.chipActive]}
            onPress={() => set({ building: opt })}
          >
            <Text style={[styles.chipText, filters.building === opt && styles.chipTextActive]}>{opt}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.filterLabel}>Received from / to (yyyy-mm-dd)</Text>
      <View style={styles.dateRow}>
        <TextInput style={styles.input} value={filters.received_from ?? ""} onChangeText={(v) => set({ received_from: v })} placeholder="from" />
        <TextInput style={styles.input} value={filters.received_to ?? ""} onChangeText={(v) => set({ received_to: v })} placeholder="to" />
      </View>

      <Text style={styles.filterLabel}>Checked out from / to (yyyy-mm-dd)</Text>
      <View style={styles.dateRow}>
        <TextInput style={styles.input} value={filters.checked_out_from ?? ""} onChangeText={(v) => set({ checked_out_from: v })} placeholder="from" />
        <TextInput style={styles.input} value={filters.checked_out_to ?? ""} onChangeText={(v) => set({ checked_out_to: v })} placeholder="to" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingBottom: 60, gap: 8 },
  topRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  toggle: { flexDirection: "row" },
  toggleBtn: { paddingHorizontal: 14, paddingVertical: 8, backgroundColor: "#eee", borderRadius: 6 },
  toggleBtnActive: { backgroundColor: "#06c" },
  toggleText: { fontSize: 14, color: "#333", fontWeight: "600" },
  toggleTextActive: { color: "white" },
  filterBtn: { paddingHorizontal: 14, paddingVertical: 8, backgroundColor: "#555", borderRadius: 6 },
  filterBtnText: { color: "white", fontWeight: "600" },
  filterSheet: { borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 12, backgroundColor: "#fafafa", marginBottom: 8 },
  filterLabel: { fontSize: 12, fontWeight: "600", marginTop: 8, color: "#333" },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 6, padding: 8, fontSize: 14, flex: 1 },
  dateRow: { flexDirection: "row", gap: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginVertical: 4 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, backgroundColor: "#eee" },
  chipActive: { backgroundColor: "#06c" },
  chipText: { fontSize: 13, color: "#333" },
  chipTextActive: { color: "white", fontWeight: "600" },
  typeBlock: { marginTop: 8 },
  typeHeader: { fontSize: 18, fontWeight: "bold", marginBottom: 4 },
  groupRow: { borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 12, backgroundColor: "white", marginBottom: 6 },
  groupHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  groupValue: { fontSize: 16, fontWeight: "600" },
  statusChip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  statusChipText: { color: "white", fontSize: 11, fontWeight: "700" },
  groupMeta: { fontSize: 12, color: "#666", marginTop: 4 },
  hint: { color: "#888", fontStyle: "italic", marginVertical: 12 },
  exportBtn: { backgroundColor: "#06c", padding: 14, borderRadius: 8, alignItems: "center", marginTop: 12 },
  exportBtnDisabled: { backgroundColor: "#9ab" },
  exportBtnText: { color: "white", fontWeight: "600", fontSize: 16 },
  exportMsg: { fontSize: 13, color: "#555", marginTop: 6, textAlign: "center" },
});
