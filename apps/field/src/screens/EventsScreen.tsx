/**
 * Event Log screen (app.py:300-310, db.py:1117-1151): `listEvents` newest-first,
 * narrowed by the four category filter chips (all / checkin / checkout / scan)
 * and an EPC substring search box.
 */

import { EVENT_FILTERS, listEvents, type EventRow } from "@rfid/domain";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { useDb } from "../db/provider";

const FILTERS = ["all", ...Object.keys(EVENT_FILTERS)] as const;
type EventFilter = (typeof FILTERS)[number];

export function EventsScreen(): React.ReactNode {
  const db = useDb();
  const [filter, setFilter] = useState<EventFilter>("all");
  const [epc, setEpc] = useState("");
  const [events, setEvents] = useState<EventRow[]>([]);

  const load = useCallback(async () => {
    setEvents(await listEvents(db, filter, epc.trim() || null));
  }, [db, filter, epc]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <View style={styles.container}>
      <View style={styles.chips}>
        {FILTERS.map((f) => (
          <Pressable
            key={f}
            onPress={() => setFilter(f)}
            style={[styles.chip, filter === f && styles.chipActive]}
          >
            <Text style={[styles.chipText, filter === f && styles.chipTextActive]}>{f}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        style={styles.input}
        value={epc}
        onChangeText={setEpc}
        placeholder="Filter by EPC (substring)"
        autoCapitalize="characters"
        autoCorrect={false}
      />

      <ScrollView contentContainerStyle={styles.list}>
        {events.length === 0 ? (
          <Text style={styles.hint}>No events match.</Text>
        ) : (
          events.map((e) => (
            <View key={e.id} style={styles.row}>
              <View style={styles.rowHead}>
                <Text style={styles.action}>{e.action}</Text>
                <Text style={styles.ts}>{e.ts}</Text>
              </View>
              {e.epc ? <Text style={styles.mono}>{e.epc}</Text> : null}
              <Text style={styles.meta}>
                {[e.item_type, e.bol_number && `BOL ${e.bol_number}`, e.building && `Bldg ${e.building}`, e.vendor]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
              {e.detail ? <Text style={styles.detail}>{e.detail}</Text> : null}
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, backgroundColor: "#eee" },
  chipActive: { backgroundColor: "#06c" },
  chipText: { fontSize: 13, color: "#333" },
  chipTextActive: { color: "white", fontWeight: "600" },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 6, padding: 10, fontSize: 14, fontFamily: "monospace" },
  list: { paddingBottom: 40, gap: 6 },
  row: { borderWidth: 1, borderColor: "#eee", borderRadius: 6, padding: 10, backgroundColor: "white" },
  rowHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  action: { fontSize: 13, fontWeight: "700", color: "#06c" },
  ts: { fontSize: 11, color: "#999" },
  mono: { fontFamily: "monospace", fontSize: 11, color: "#444", marginTop: 2 },
  meta: { fontSize: 12, color: "#666", marginTop: 2 },
  detail: { fontSize: 12, color: "#555", marginTop: 2, fontStyle: "italic" },
  hint: { color: "#888", fontStyle: "italic", marginTop: 12 },
});
