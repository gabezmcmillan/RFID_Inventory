/**
 * `CheckoutConfirmCard` — the two-step Check Out confirm UI (db.py:744-857,
 * app.py:196-203). A trigger pull (or the warehouse "Check Out" button) only
 * looks a box up; this card shows its details and lets the operator choose
 * how many units to draw and to which building, then commits via
 * {@link onCommit}. The card never calls `deliverUnits` itself — the caller
 * commits so plan 008's request-staging flow can reuse it in `staged` mode.
 *
 * An `ok:false` lookup (unregistered / already-empty box) renders as an error
 * card with no commit controls, so both entry points (scan and warehouse
 * drill-down) can hand the result straight to the card.
 */

import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

import { BUILDING_OPTIONS, type LookupForCheckoutResult } from "@rfid/domain";

interface CheckoutConfirmCardProps {
  /** The lookup result to render (ok or error). */
  readonly lookupResult: LookupForCheckoutResult;
  /** Commit `amount` units to `building`; the caller runs `deliverUnits`. */
  readonly onCommit: (amount: number, building: string) => void;
  /** True in plan 008's request-staging mode (commit labels as "Stage"). */
  readonly staged?: boolean;
  /** Pre-filled destination building (staging mode defaults to the request's). */
  readonly defaultBuilding?: string;
  /** Disable the commit button while a commit is in flight. */
  readonly busy?: boolean;
}

/**
 * Render the confirm card. Owns only the amount stepper and destination
 * building field; resets them when the lookup result (epc) changes.
 */
export function CheckoutConfirmCard({
  lookupResult,
  onCommit,
  staged = false,
  defaultBuilding = "",
  busy = false,
}: CheckoutConfirmCardProps): React.ReactNode {
  const remaining = lookupResult.remaining ?? 0;
  const [amount, setAmount] = useState(remaining);
  const [building, setBuilding] = useState(defaultBuilding);

  // Re-arm the stepper/destination whenever a new box is looked up.
  useEffect(() => {
    setAmount(remaining);
    setBuilding(defaultBuilding);
  }, [lookupResult.epc, remaining, defaultBuilding]);

  if (!lookupResult.ok) {
    return (
      <View className="rounded-lg border border-destructive bg-destructive/10 p-3.5">
        <Text className="font-semibold text-destructive">{lookupResult.message}</Text>
      </View>
    );
  }

  const max = remaining;
  const step = (delta: number): void => {
    setAmount((n) => Math.min(max, Math.max(1, n + delta)));
  };

  const commit = (): void => {
    if (busy) return;
    onCommit(Math.min(Math.max(1, amount), max), building.trim());
  };

  const verb = staged ? "Stage" : "Deliver";

  return (
    <View className="rounded-lg border border-border bg-card p-3.5">
      <Text className="mb-1 text-lg font-bold text-foreground">
        {lookupResult.item_type}
        {lookupResult.item_name ? ` · ${lookupResult.item_name}` : ""}
      </Text>
      <Text className="mt-0.5 text-[13px] text-muted-foreground">EPC: {lookupResult.epc}</Text>
      <Text className="mt-0.5 text-[13px] text-muted-foreground">
        BOL {lookupResult.bol_number || "n/a"} · Received for Bldg {lookupResult.building || "n/a"}
      </Text>
      <Text className="mt-0.5 text-[13px] text-muted-foreground">
        Units: <Text className="font-semibold text-foreground">{remaining}</Text> of {lookupResult.quantity} remaining
      </Text>

      <Text className="mb-1 mt-3 text-[13px] font-semibold text-foreground">Units to draw</Text>
      <View className="flex-row items-center gap-3">
        <Button size="icon" variant="secondary" onPress={() => step(-1)}>
          <Text>−</Text>
        </Button>
        <Text className="min-w-12 text-center text-lg font-semibold">{amount}</Text>
        <Button size="icon" variant="secondary" onPress={() => step(1)}>
          <Text>+</Text>
        </Button>
      </View>

      <Text className="mb-1 mt-3 text-[13px] font-semibold text-foreground">Destination building</Text>
      <View className="mb-2 flex-row flex-wrap gap-2">
        {BUILDING_OPTIONS.map((opt) => (
          <Pressable
            key={opt}
            onPress={() => setBuilding(opt)}
            className={cn("rounded-md px-3.5 py-2", building === opt ? "bg-brand-info" : "bg-muted")}
          >
            <Text
              className={cn(
                "text-sm",
                building === opt ? "text-white font-semibold" : "text-foreground",
              )}
            >
              {opt}
            </Text>
          </Pressable>
        ))}
      </View>
      <Input
        value={building}
        onChangeText={setBuilding}
        placeholder="Other building (free entry)"
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Button size="lg" className="mt-3" disabled={busy} onPress={commit}>
        <Text className="text-[17px] font-semibold">
          {busy ? "…" : `${verb} ${amount} unit${amount === 1 ? "" : "s"}`}
        </Text>
      </Button>
    </View>
  );
}
