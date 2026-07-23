/**
 * Event Log screen (app.py:300-310, db.py:1117-1151): `listEvents` newest-first,
 * narrowed by the four category filter chips (all / checkin / checkout / scan)
 * and an EPC substring search box.
 */

import { EVENT_FILTERS, listEvents, type EventRow } from "@rfid/domain";
import { useCallback, useEffect, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";

import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { KeyboardDismissible } from "@/components/KeyboardDismissible";
import { cn } from "@/lib/utils";

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
    <KeyboardDismissible className="flex-1 gap-2 p-4">
      <View className="flex-row flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Pressable
            key={f}
            onPress={() => setFilter(f)}
            className={cn("rounded-full px-3 py-1.5", filter === f ? "bg-brand-info" : "bg-muted")}
          >
            <Text className={cn("text-[13px]", filter === f ? "text-white font-semibold" : "text-foreground")}>{f}</Text>
          </Pressable>
        ))}
      </View>
      <Input
        className="font-mono"
        value={epc}
        onChangeText={setEpc}
        placeholder="Filter by EPC (substring)"
        autoCapitalize="characters"
        autoCorrect={false}
      />

      <ScrollView
        contentContainerStyle={{ paddingBottom: 40, gap: 6 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
      >
        {events.length === 0 ? (
          <Text className="mt-3 text-sm italic text-muted-foreground">No events match.</Text>
        ) : (
          events.map((e) => (
            <View key={e.id} className="rounded-md border border-border bg-card p-2.5">
              <View className="flex-row items-center justify-between">
                <Text className="text-[13px] font-bold text-brand-info">{e.action}</Text>
                <Text className="text-[11px] text-muted-foreground/70">{e.ts}</Text>
              </View>
              {e.epc ? <Text className="mt-0.5 font-mono text-[11px] text-muted-foreground">{e.epc}</Text> : null}
              <Text className="mt-0.5 text-xs text-muted-foreground">
                {[e.item_type, e.bol_number && `BOL ${e.bol_number}`, e.building && `Bldg ${e.building}`, e.vendor]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
              {e.detail ? <Text className="mt-0.5 text-xs italic text-muted-foreground">{e.detail}</Text> : null}
            </View>
          ))
        )}
      </ScrollView>
    </KeyboardDismissible>
  );
}
