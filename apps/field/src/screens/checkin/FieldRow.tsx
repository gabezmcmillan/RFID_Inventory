/**
 * `FieldRow` — renders one {@link FieldDef} as the appropriate control:
 * `buttons`/`select` as a segmented chip row (vendor `select` also offers an
 * inline "+ add" that calls {@link onAddVendor}), and `text`/`date`/`number` as
 * a text input. Kept presentational; the owning screen owns the values.
 */

import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import type { FieldDef } from "@rfid/domain";

interface FieldRowProps {
  field: FieldDef;
  value: string;
  onChange: (value: string) => void;
  /** Vendor options for `select` fields (from `listVendors`). */
  vendors?: readonly string[];
  /** Add a new vendor (for `select` fields); refreshes the options. */
  onAddVendor?: (name: string) => Promise<void> | void;
}

export function FieldRow({
  field,
  value,
  onChange,
  vendors = [],
  onAddVendor,
}: FieldRowProps): React.ReactNode {
  if (field.type === "buttons" || field.type === "select") {
    const options = field.type === "buttons" ? field.options ?? [] : vendors;
    return (
      <View style={styles.row}>
        <Text style={styles.label}>{field.label}</Text>
        <View style={styles.chips}>
          {options.map((opt) => (
            <Pressable
              key={opt}
              onPress={() => onChange(opt)}
              style={[styles.chip, value === opt && styles.chipActive]}
            >
              <Text style={[styles.chipText, value === opt && styles.chipTextActive]}>{opt}</Text>
            </Pressable>
          ))}
          {field.type === "select" && onAddVendor ? (
            <AddVendorChip onAdd={onAddVendor} />
          ) : null}
        </View>
      </View>
    );
  }
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{field.label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        keyboardType={field.type === "number" ? "numeric" : "default"}
        placeholder={field.label}
      />
    </View>
  );
}

/** Inline "+ add vendor" chip with a tiny text entry. */
function AddVendorChip({ onAdd }: { onAdd: (name: string) => Promise<void> | void }): React.ReactNode {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  if (!adding) {
    return (
      <Pressable style={styles.chip} onPress={() => setAdding(true)}>
        <Text style={styles.chipText}>+ add</Text>
      </Pressable>
    );
  }
  return (
    <View style={styles.addRow}>
      <TextInput
        style={styles.addInput}
        autoFocus
        value={name}
        onChangeText={setName}
        placeholder="vendor name"
      />
      <Pressable
        style={styles.chip}
        onPress={async () => {
          const trimmed = name.trim();
          if (trimmed) await onAdd(trimmed);
          setName("");
          setAdding(false);
        }}
      >
        <Text style={styles.chipText}>save</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { marginBottom: 12 },
  label: { fontSize: 14, fontWeight: "600", marginBottom: 6, color: "#333" },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 6, padding: 10, fontSize: 16 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6, backgroundColor: "#eee" },
  chipActive: { backgroundColor: "#0a7" },
  chipText: { fontSize: 14, color: "#333" },
  chipTextActive: { color: "white", fontWeight: "600" },
  addRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  addInput: { borderWidth: 1, borderColor: "#ccc", borderRadius: 6, padding: 6, fontSize: 14, width: 120 },
});
