/**
 * Dev Tools route (dev builds) — the no-hardware rig: a text box to inject one
 * or more EPCs via `readerService.injectScan`, the equivalent of
 * `POST /api/simulate_scan` (app.py:1065-1071), plus a "Insert sample request"
 * button that seeds a small cart order (two lines sharing an `order_ref`, one a
 * W.I.F. line carrying an `item_name`) via `createRequest` so the Requests
 * flow can be exercised end-to-end before plan 010 syncs real rows.
 */

import { createRequest } from "@rfid/domain";
import { useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Text } from "@/components/ui/text";

import { useDb } from "../src/db/provider";
import { readerService } from "../src/reader/readerService";
import { notifyRequestsChanged } from "../src/screens/requests/refresh";

export default function DevToolsScreen(): React.ReactNode {
  const db = useDb();
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const inject = (): void => {
    const epcs = text
      .split(/[\s,]+/)
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0);
    if (epcs.length === 0) return;
    readerService.injectScan(epcs);
    setText("");
  };

  const insertSampleRequest = async (): Promise<void> => {
    const orderRef = `CART-${Date.now().toString(36).toUpperCase()}`;
    await createRequest(db, {
      item_type: "TSC",
      quantity: 3,
      building: "6",
      jobsite: "North Tower",
      requester: "A. Rivera",
      contact: "arivera@example.com",
      note: "For the pour on Friday.",
      order_ref: orderRef,
    });
    await createRequest(db, {
      item_type: "W.I.F.",
      item_name: "Widget Bracket",
      quantity: 2,
      building: "6",
      jobsite: "North Tower",
      requester: "A. Rivera",
      contact: "arivera@example.com",
      note: "Match the bracket spec on drawing S-4.",
      order_ref: orderRef,
    });
    notifyRequestsChanged();
    setMsg("Inserted 2 sample requests (shared order_ref).");
  };

  return (
    <View className="flex-1 p-5 gap-3">
      <Text className="text-sm font-semibold">Inject EPCs (whitespace/comma separated)</Text>
      <Input
        value={text}
        onChangeText={setText}
        placeholder="AAAA11112222333344445555"
        multiline
        autoCapitalize="characters"
        className="min-h-20 font-mono"
      />
      <Button onPress={inject}>
        <Text>Inject scan</Text>
      </Button>
      <Text className="text-xs text-muted-foreground">
        Tip: arm a shipment on the Check In screen first, then inject here to record it.
      </Text>

      <Separator className="my-1" />

      <Text className="text-sm font-semibold">Requests</Text>
      <Button onPress={() => void insertSampleRequest()}>
        <Text>Insert sample request</Text>
      </Button>
      {msg ? <Text className="text-primary font-semibold">{msg}</Text> : null}
    </View>
  );
}
