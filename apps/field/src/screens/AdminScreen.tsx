/**
 * Admin screen (app.py:797-916, config.py:157-159): PIN-gated (stored in
 * AsyncStorage, default "1234") — "light protection for a trusted machine, not
 * real security". After unlock: tag editor (lookup by EPC → form over the
 * domain `EDITABLE_FIELDS` → `updateTag`), clear flag, delete group (type +
 * group picker → `deleteGroup`, destructive confirm), remove vendor, and
 * "Clear database" (double confirm → `clearAll`). A "Change PIN" field updates
 * the stored PIN.
 */

import {
  clearAll,
  clearFlag,
  deleteGroup,
  EDITABLE_FIELDS,
  ITEM_TYPES,
  listVendors,
  removeVendor,
  STATUS_DELIVERED,
  STATUS_IN,
  STATUS_PARTIAL,
  updateTag,
  type Tag,
} from "@rfid/domain";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { useDb } from "../db/provider";

/** AsyncStorage key for the admin PIN. */
const ADMIN_PIN_KEY = "rfid.field.adminPin";
/** Default PIN (config.py:159). */
const DEFAULT_PIN = "1234";

const STATUS_OPTIONS = [STATUS_IN, STATUS_PARTIAL, STATUS_DELIVERED];

async function loadPin(): Promise<string> {
  return (await AsyncStorage.getItem(ADMIN_PIN_KEY)) ?? DEFAULT_PIN;
}

async function savePin(pin: string): Promise<void> {
  await AsyncStorage.setItem(ADMIN_PIN_KEY, pin);
}

export function AdminScreen(): React.ReactNode {
  const [unlocked, setUnlocked] = useState(false);
  if (!unlocked) {
    return <PinPrompt onUnlock={() => setUnlocked(true)} />;
  }
  return <AdminTools />;
}

/** PIN entry; unlocks on a match against the stored PIN. */
function PinPrompt({ onUnlock }: { onUnlock: () => void }): React.ReactNode {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const stored = await loadPin();
    if (pin === stored) {
      onUnlock();
    } else {
      setError("Invalid PIN.");
      setPin("");
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Admin PIN</Text>
      <TextInput
        style={styles.input}
        value={pin}
        onChangeText={setPin}
        placeholder="PIN"
        secureTextEntry
        keyboardType="number-pad"
      />
      <Pressable style={styles.primary} onPress={() => void submit()}>
        <Text style={styles.primaryText}>Unlock</Text>
      </Pressable>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

/** The unlocked admin surface: tag editor, clear flag, delete group, vendor, clear db, change PIN. */
function AdminTools(): React.ReactNode {
  const db = useDb();
  const [vendors, setVendors] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  const refreshVendors = useCallback(async () => {
    setVendors(await listVendors(db));
  }, [db]);

  useEffect(() => {
    void refreshVendors();
  }, [refreshVendors]);

  const onDeleteGroup = async (itemType: string, groupBy: string, value: string): Promise<void> => {
    const result = await deleteGroup(db, itemType, groupBy, value);
    setMsg(result.message);
  };

  const onRemoveVendor = (name: string): void => {
    Alert.alert("Remove vendor", `Remove "${name}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          const result = await removeVendor(db, name);
          setMsg(result.message);
          await refreshVendors();
        },
      },
    ]);
  };

  const onClearAll = (): void => {
    Alert.alert("Clear database", "Delete every tag and BOL document? Events are kept.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Continue",
        style: "destructive",
        onPress: () => {
          Alert.alert("Are you absolutely sure?", "This cannot be undone.", [
            { text: "Cancel", style: "cancel" },
            {
              text: "Clear everything",
              style: "destructive",
              onPress: async () => {
                const result = await clearAll(db);
                setMsg(result.message);
                await refreshVendors();
              },
            },
          ]);
        },
      },
    ]);
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <TagEditor onMsg={setMsg} />
      <ClearFlagSection onMsg={setMsg} />
      <DeleteGroupSection onConfirm={onDeleteGroup} />
      <VendorSection vendors={vendors} onRemove={onRemoveVendor} />
      <ClearDbSection onConfirm={onClearAll} />
      <ChangePinSection onMsg={setMsg} />
      {msg ? <Text style={styles.msg}>{msg}</Text> : null}
    </ScrollView>
  );
}

/** Tag editor: lookup by EPC, edit EDITABLE_FIELDS, commit via updateTag. */
function TagEditor({ onMsg }: { onMsg: (m: string) => void }): React.ReactNode {
  const db = useDb();
  const [epc, setEpc] = useState("");
  const [tag, setTag] = useState<Tag | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const lookup = async (): Promise<void> => {
    if (!epc.trim()) return;
    const { findTag } = await import("@rfid/domain");
    const found = await findTag(db, epc.trim());
    if (!found) {
      onMsg(`${epc.trim()} is not registered.`);
      setTag(null);
      return;
    }
    setTag(found);
    setForm(Object.fromEntries(EDITABLE_FIELDS.map((k) => [k, String(found[k as keyof Tag] ?? "")])));
  };

  const commit = async (): Promise<void> => {
    if (!tag || busy) return;
    setBusy(true);
    try {
      const result = await updateTag(db, tag.epc, form);
      onMsg(result.message);
      if (result.tag) {
        setTag(result.tag);
        setForm(Object.fromEntries(EDITABLE_FIELDS.map((k) => [k, String(result.tag![k as keyof Tag] ?? "")])));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Edit tag</Text>
      <View style={styles.row}>
        <TextInput style={styles.input} value={epc} onChangeText={setEpc} placeholder="EPC" autoCapitalize="characters" />
        <Pressable style={styles.miniBtn} onPress={() => void lookup()}><Text style={styles.miniBtnText}>Find</Text></Pressable>
      </View>
      {tag
        ? (
          <>
            {EDITABLE_FIELDS.map((k) =>
              k === "status" ? (
                <View key={k}>
                  <Text style={styles.label}>status</Text>
                  <View style={styles.chips}>
                    {STATUS_OPTIONS.map((opt) => (
                      <Pressable
                        key={opt}
                        style={[styles.chip, form["status"] === opt && styles.chipActive]}
                        onPress={() => setForm({ ...form, status: opt })}
                      >
                        <Text style={[styles.chipText, form["status"] === opt && styles.chipTextActive]}>{opt}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              ) : (
                <View key={k}>
                  <Text style={styles.label}>{k}</Text>
                  <TextInput
                    style={styles.input}
                    value={form[k] ?? ""}
                    onChangeText={(v) => setForm({ ...form, [k]: v })}
                    keyboardType={k === "quantity" || k === "remaining" ? "numeric" : "default"}
                  />
                </View>
              ),
            )}
            <Pressable style={[styles.primary, busy && styles.btnDisabled]} disabled={busy} onPress={() => void commit()}>
              <Text style={styles.primaryText}>{busy ? "…" : "Save"}</Text>
            </Pressable>
          </>
        )
        : null}
    </View>
  );
}

/** Clear a tag's warning flag by EPC. */
function ClearFlagSection({ onMsg }: { onMsg: (m: string) => void }): React.ReactNode {
  const db = useDb();
  const [epc, setEpc] = useState("");
  const run = async (): Promise<void> => {
    if (!epc.trim()) return;
    const result = await clearFlag(db, epc.trim());
    onMsg(result.message);
  };
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Clear flag</Text>
      <View style={styles.row}>
        <TextInput style={styles.input} value={epc} onChangeText={setEpc} placeholder="EPC" autoCapitalize="characters" />
        <Pressable style={styles.miniBtn} onPress={() => void run()}><Text style={styles.miniBtnText}>Clear</Text></Pressable>
      </View>
    </View>
  );
}

/** Delete every tag in one (item_type, group) cell, with a confirm dialog. */
function DeleteGroupSection({
  onConfirm,
}: {
  onConfirm: (itemType: string, groupBy: string, value: string) => Promise<void>;
}): React.ReactNode {
  const [itemType, setItemType] = useState<string>(ITEM_TYPES[0] ?? "");
  const [groupBy, setGroupBy] = useState<"bol" | "building">("bol");
  const [value, setValue] = useState("");

  const confirm = (): void => {
    if (!value.trim()) return;
    Alert.alert("Delete group", `Delete every ${itemType} box for ${groupBy} "${value}"?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void onConfirm(itemType, groupBy, value.trim()) },
    ]);
  };

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Delete group</Text>
      <Text style={styles.label}>Item type</Text>
      <View style={styles.chips}>
        {ITEM_TYPES.map((t) => (
          <Pressable key={t} style={[styles.chip, itemType === t && styles.chipActive]} onPress={() => setItemType(t)}>
            <Text style={[styles.chipText, itemType === t && styles.chipTextActive]}>{t}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.label}>Group by</Text>
      <View style={styles.chips}>
        <Pressable style={[styles.chip, groupBy === "bol" && styles.chipActive]} onPress={() => setGroupBy("bol")}>
          <Text style={[styles.chipText, groupBy === "bol" && styles.chipTextActive]}>BOL</Text>
        </Pressable>
        <Pressable style={[styles.chip, groupBy === "building" && styles.chipActive]} onPress={() => setGroupBy("building")}>
          <Text style={[styles.chipText, groupBy === "building" && styles.chipTextActive]}>Building</Text>
        </Pressable>
      </View>
      <Text style={styles.label}>Value</Text>
      <TextInput style={styles.input} value={value} onChangeText={setValue} placeholder="BOL # / Building # / Item Name" />
      <Pressable style={[styles.primary, styles.danger]} onPress={confirm}>
        <Text style={styles.primaryText}>Delete group</Text>
      </Pressable>
    </View>
  );
}

/** Remove a vendor from the list. */
function VendorSection({
  vendors,
  onRemove,
}: {
  vendors: readonly string[];
  onRemove: (name: string) => void;
}): React.ReactNode {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Vendors</Text>
      {vendors.length === 0 ? (
        <Text style={styles.hint}>No vendors.</Text>
      ) : (
        vendors.map((v) => (
          <View key={v} style={styles.vendorRow}>
            <Text style={styles.vendorName}>{v}</Text>
            <Pressable style={styles.miniBtn} onPress={() => onRemove(v)}><Text style={styles.miniBtnText}>Remove</Text></Pressable>
          </View>
        ))
      )}
    </View>
  );
}

/** Clear database with a double confirm. */
function ClearDbSection({ onConfirm }: { onConfirm: () => void }): React.ReactNode {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Danger zone</Text>
      <Pressable style={[styles.primary, styles.danger]} onPress={onConfirm}>
        <Text style={styles.primaryText}>Clear database</Text>
      </Pressable>
    </View>
  );
}

/** Change the stored admin PIN. */
function ChangePinSection({ onMsg }: { onMsg: (m: string) => void }): React.ReactNode {
  const [pin, setPin] = useState("");
  const run = async (): Promise<void> => {
    const clean = pin.trim();
    if (clean.length < 1) {
      onMsg("PIN cannot be empty.");
      return;
    }
    await savePin(clean);
    setPin("");
    onMsg("PIN updated.");
  };
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Change PIN</Text>
      <TextInput
        style={styles.input}
        value={pin}
        onChangeText={setPin}
        placeholder="New PIN"
        secureTextEntry
        keyboardType="number-pad"
      />
      <Pressable style={styles.primary} onPress={() => void run()}><Text style={styles.primaryText}>Save PIN</Text></Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingBottom: 60, gap: 10 },
  title: { fontSize: 22, fontWeight: "bold", marginBottom: 8 },
  section: { borderWidth: 1, borderColor: "#eee", borderRadius: 8, padding: 12, backgroundColor: "white" },
  sectionTitle: { fontSize: 16, fontWeight: "bold", marginBottom: 8 },
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  input: { flex: 1, borderWidth: 1, borderColor: "#ccc", borderRadius: 6, padding: 10, fontSize: 14 },
  label: { fontSize: 12, fontWeight: "600", marginTop: 8, marginBottom: 4, color: "#333" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, backgroundColor: "#eee" },
  chipActive: { backgroundColor: "#06c" },
  chipText: { fontSize: 13, color: "#333" },
  chipTextActive: { color: "white", fontWeight: "600" },
  miniBtn: { paddingHorizontal: 12, paddingVertical: 10, backgroundColor: "#555", borderRadius: 6 },
  miniBtnText: { color: "white", fontWeight: "600" },
  primary: { backgroundColor: "#0a7", padding: 14, borderRadius: 8, alignItems: "center", marginTop: 10 },
  primaryText: { color: "white", fontWeight: "600" },
  danger: { backgroundColor: "#c33" },
  btnDisabled: { backgroundColor: "#9ab" },
  error: { color: "#c33", marginTop: 8 },
  hint: { color: "#888", fontStyle: "italic" },
  vendorRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 6 },
  vendorName: { fontSize: 15 },
  msg: { color: "#0a7", fontWeight: "600", marginTop: 8 },
});
