/**
 * `ResultCard` — one entry in the check-in session list: the intake result
 * message, the EPC, and the group qty. Duplicates render as a warning (amber).
 * The newest card shows an "Edit" button opening the amend sheet.
 */

import { Pressable, StyleSheet, Text, View } from "react-native";

import type { ReceiveShipmentResult } from "@rfid/domain";

export interface CheckInResult {
  readonly epc: string;
  readonly result: ReceiveShipmentResult;
  readonly duplicate: boolean;
}

interface ResultCardProps {
  entry: CheckInResult;
  newest: boolean;
  onAmend: (epc: string) => void;
}

export function ResultCard({ entry, newest, onAmend }: ResultCardProps): React.ReactNode {
  const { result, duplicate } = entry;
  return (
    <View style={[styles.card, duplicate && styles.cardDup]}>
      <View style={styles.head}>
        <Text style={[styles.message, duplicate && styles.messageDup]}>{result.message}</Text>
        {newest && !duplicate ? (
          <Pressable onPress={() => onAmend(entry.epc)} style={styles.editBtn}>
            <Text style={styles.editText}>Edit</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.meta}>EPC: {entry.epc}</Text>
      <Text style={styles.meta}>Group qty: {result.qty}</Text>
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
