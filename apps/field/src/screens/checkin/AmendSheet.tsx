/**
 * `AmendSheet` — operator correction of the just-scanned tag. Edits the four
 * amendable fields (Item Name / Item No. / mfc date / qty) and calls
 * {@link onAmend}; the domain `IntakeSession.amend` drops any other keys.
 */

import { useEffect, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import type { ItemFields } from "@rfid/domain";

interface AmendSheetProps {
  epc: string | null;
  initial: ItemFields;
  onAmend: (epc: string, fields: ItemFields) => Promise<void>;
  onClose: () => void;
}

/** Build the amendable-fields form state from an initial ItemFields. */
function toForm(f: ItemFields): Record<string, string> {
  return {
    item_name: f.item_name ?? "",
    sku: f.sku ?? "",
    mfc_date: f.mfc_date ?? "",
    quantity: f.quantity === undefined ? "" : String(f.quantity),
  };
}

export function AmendSheet({ epc, initial, onAmend, onClose }: AmendSheetProps): React.ReactNode {
  const [form, setForm] = useState<Record<string, string>>(() => toForm(initial));
  useEffect(() => {
    setForm(toForm(initial));
  }, [initial]);

  const visible = epc !== null;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>Amend tag</Text>
          <Text style={styles.epc}>{epc ?? ""}</Text>
          <Field label="Item Name" value={form.item_name} onChange={(v) => setForm({ ...form, item_name: v })} />
          <Field label="Item No." value={form.sku} onChange={(v) => setForm({ ...form, sku: v })} />
          <Field label="Mfc date" value={form.mfc_date} onChange={(v) => setForm({ ...form, mfc_date: v })} />
          <Field label="Quantity" value={form.quantity} onChange={(v) => setForm({ ...form, quantity: v })} numeric />
          <View style={styles.actions}>
            <Pressable style={styles.cancel} onPress={onClose}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={styles.save}
              onPress={async () => {
                if (!epc) return;
                const qty = form.quantity.trim();
                await onAmend(epc, {
                  item_name: form.item_name,
                  sku: form.sku,
                  mfc_date: form.mfc_date,
                  quantity: qty === "" ? undefined : Number(qty),
                });
                onClose();
              }}
            >
              <Text style={styles.saveText}>Save</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function Field({
  label,
  value,
  onChange,
  numeric,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  numeric?: boolean;
}): React.ReactNode {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        keyboardType={numeric ? "numeric" : "default"}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.4)" },
  sheet: { backgroundColor: "white", padding: 20, borderTopLeftRadius: 16, borderTopRightRadius: 16, gap: 8 },
  title: { fontSize: 20, fontWeight: "bold" },
  epc: { fontSize: 12, color: "#666", marginBottom: 8, fontFamily: "monospace" },
  field: { marginBottom: 10 },
  label: { fontSize: 14, fontWeight: "600", marginBottom: 4 },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 6, padding: 10, fontSize: 16 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 12, marginTop: 8 },
  cancel: { paddingHorizontal: 16, paddingVertical: 10 },
  cancelText: { color: "#666", fontSize: 16 },
  save: { backgroundColor: "#0a7", paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 },
  saveText: { color: "white", fontSize: 16, fontWeight: "600" },
});
