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
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

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
      <View style={styles.errorCard}>
        <Text style={styles.errorText}>{lookupResult.message}</Text>
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
    <View style={styles.card}>
      <Text style={styles.title}>
        {lookupResult.item_type}
        {lookupResult.item_name ? ` · ${lookupResult.item_name}` : ""}
      </Text>
      <Text style={styles.meta}>
        EPC: {lookupResult.epc}
      </Text>
      <Text style={styles.meta}>
        BOL {lookupResult.bol_number || "n/a"} · Received for Bldg {lookupResult.building || "n/a"}
      </Text>
      <Text style={styles.meta}>
        Units: <Text style={styles.bold}>{remaining}</Text> of {lookupResult.quantity} remaining
      </Text>

      <Text style={styles.label}>Units to draw</Text>
      <View style={styles.stepper}>
        <Pressable style={styles.stepBtn} onPress={() => step(-1)}>
          <Text style={styles.stepText}>−</Text>
        </Pressable>
        <Text style={styles.amountValue}>{amount}</Text>
        <Pressable style={styles.stepBtn} onPress={() => step(1)}>
          <Text style={styles.stepText}>+</Text>
        </Pressable>
      </View>

      <Text style={styles.label}>Destination building</Text>
      <View style={styles.chips}>
        {BUILDING_OPTIONS.map((opt) => (
          <Pressable
            key={opt}
            onPress={() => setBuilding(opt)}
            style={[styles.chip, building === opt && styles.chipActive]}
          >
            <Text style={[styles.chipText, building === opt && styles.chipTextActive]}>{opt}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        style={styles.input}
        value={building}
        onChangeText={setBuilding}
        placeholder="Other building (free entry)"
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Pressable style={[styles.commitBtn, busy && styles.commitBtnDisabled]} disabled={busy} onPress={commit}>
        <Text style={styles.commitBtnText}>
          {busy ? "…" : `${verb} ${amount} unit${amount === 1 ? "" : "s"}`}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 14, backgroundColor: "white" },
  errorCard: { borderWidth: 1, borderColor: "#c33", borderRadius: 8, padding: 14, backgroundColor: "#fdecea" },
  errorText: { color: "#c33", fontWeight: "600" },
  title: { fontSize: 18, fontWeight: "bold", marginBottom: 4 },
  meta: { fontSize: 13, color: "#555", marginTop: 2 },
  bold: { fontWeight: "600", color: "#222" },
  label: { fontSize: 13, fontWeight: "600", marginTop: 12, marginBottom: 4, color: "#333" },
  stepper: { flexDirection: "row", alignItems: "center", gap: 12 },
  stepBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: "#eee", alignItems: "center", justifyContent: "center" },
  stepText: { fontSize: 22, fontWeight: "600" },
  amountValue: { fontSize: 18, fontWeight: "600", minWidth: 48, textAlign: "center" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6, backgroundColor: "#eee" },
  chipActive: { backgroundColor: "#06c" },
  chipText: { fontSize: 14, color: "#333" },
  chipTextActive: { color: "white", fontWeight: "600" },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 6, padding: 10, fontSize: 16 },
  commitBtn: { backgroundColor: "#0a7", padding: 14, borderRadius: 8, alignItems: "center", marginTop: 12 },
  commitBtnDisabled: { backgroundColor: "#9ab" },
  commitBtnText: { color: "white", fontSize: 17, fontWeight: "600" },
});
