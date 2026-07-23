/**
 * `ResultCard` — one entry in the check-in session list: the intake result
 * message, the EPC, and the group qty. Duplicates render as a warning (amber).
 * The newest card shows an "Edit" button opening the amend sheet. Accepts both
 * the scan-path result and the print-path failure (`{ok:false, message}`) so
 * that neither path needs a type assertion to build a card.
 */

import { Pressable, View } from "react-native";

import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

import type { ReceiveShipmentResult } from "@rfid/domain";

/** A card may show a full receive result or a print-path failure message. */
export type CardResult = ReceiveShipmentResult | { readonly ok: false; readonly message: string };

export interface CheckInResult {
  readonly epc: string;
  readonly result: CardResult;
  readonly duplicate: boolean;
}

interface ResultCardProps {
  entry: CheckInResult;
  newest: boolean;
  onAmend: (epc: string) => void;
}

export function ResultCard({ entry, newest, onAmend }: ResultCardProps): React.ReactNode {
  const { result, duplicate } = entry;
  const qty = "qty" in result ? result.qty : undefined;
  const isDuplicate = duplicate || (result.ok && "added" in result && result.added === 0);
  return (
    <View
      className={cn(
        "mb-2 rounded-xl border p-3.5",
        isDuplicate ? "border-status-partial bg-status-partial/10" : "border-border bg-card",
      )}
    >
      <View className="flex-row items-start justify-between">
        <Text
          className={cn(
            "flex-1 text-[15px] font-semibold",
            isDuplicate ? "text-status-partial" : "text-foreground",
          )}
        >
          {result.message}
        </Text>
        {newest && !isDuplicate ? (
          <Pressable onPress={() => onAmend(entry.epc)} className="rounded-lg bg-muted px-3 py-1.5 active:opacity-70">
            <Text className="text-[13px] font-semibold text-foreground">Edit</Text>
          </Pressable>
        ) : null}
      </View>
      <Text className="mt-1.5 font-mono text-xs text-muted-foreground">EPC: {entry.epc}</Text>
      <Text className="mt-1 font-mono text-xs tabular-nums text-muted-foreground">Group qty: {qty ?? "—"}</Text>
    </View>
  );
}
