/**
 * `ResultCard` — one entry in the check-in session list: the intake result
 * message, the EPC, and the group qty. Duplicates render as a warning (amber).
 * The newest card shows an "Edit" button opening the amend sheet. Accepts both
 * the scan-path result and the print-path failure (`{ok:false, message}`) so
 * neither path needs a type assertion to build a card.
 */

import { Pressable, StyleSheet, Text, View } from "react-native";

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
    <View style={[styles.card, isDuplicate && styles.cardDup]}>
      <View style={styles.head}>
        <Text style={[styles.message, isDuplicate && styles.messageDup]}>{result.message}</Text>
        {newest && !isDuplicate ? (
          <Pressable onPress={() => onAmend(entry.epc)} style={styles.editBtn}>
            <Text style={styles.editText}>Edit</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.meta}>EPC: {entry.epc}</Text>
      <Text style={styles.meta}>Group qty: {qty ?? "—"}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 12, marginBottom: 8, backgroundColor: "white" },
  cardDup: { borderColor: "#e6a700", backgroundColor: "#fff8e1" },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  message: { fontSize: 15, fontWeight: "600", flex: 1, color: "#222" },
  messageDup: { color: "#9a6a00" },
  editBtn: { paddingHorizontal: 10, paddingVertical: 4, backgroundColor: "#eee", borderRadius: 6 },
  editText: { fontSize: 13, color: "#333", fontWeight: "600" },
  meta: { fontSize: 12, color: "#666", marginTop: 4 },
});
