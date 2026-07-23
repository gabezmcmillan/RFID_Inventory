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
  findTag,
  ITEM_TYPES,
  listVendors,
  removeVendor,
  STATUS_DELIVERED,
  STATUS_IN,
  STATUS_PARTIAL,
  updateTag,
  type Tag,
} from "@rfid/domain";
import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

import { useDb } from "../db/provider";
import { PinPrompt, setAdminPin } from "./adminPin";

const STATUS_OPTIONS = [STATUS_IN, STATUS_PARTIAL, STATUS_DELIVERED];

export function AdminScreen(): React.ReactNode {
  const [unlocked, setUnlocked] = useState(false);
  if (!unlocked) {
    return <PinPrompt onUnlock={() => setUnlocked(true)} />;
  }
  return <AdminTools />;
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
    <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 60, gap: 10 }}>
      <TagEditor onMsg={setMsg} />
      <ClearFlagSection onMsg={setMsg} />
      <DeleteGroupSection onConfirm={onDeleteGroup} />
      <VendorSection vendors={vendors} onRemove={onRemoveVendor} />
      <ClearDbSection onConfirm={onClearAll} />
      <ChangePinSection onMsg={setMsg} />
      {msg ? <Text className="mt-2 font-semibold text-primary">{msg}</Text> : null}
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
    <View className="rounded-lg border border-border bg-card p-3">
      <Text className="mb-2 text-base font-bold text-foreground">Edit tag</Text>
      <View className="flex-row items-center gap-2">
        <Input className="flex-1" value={epc} onChangeText={setEpc} placeholder="EPC" autoCapitalize="characters" />
        <Button variant="secondary" onPress={() => void lookup()}><Text>Find</Text></Button>
      </View>
      {tag
        ? (
          <>
            {EDITABLE_FIELDS.map((k) =>
              k === "status" ? (
                <View key={k}>
                  <Text className="mb-1 mt-2 text-xs font-semibold text-foreground">status</Text>
                  <View className="flex-row flex-wrap gap-1.5">
                    {STATUS_OPTIONS.map((opt) => (
                      <Pressable
                        key={opt}
                        className={cn("rounded-md px-3 py-1.5", form["status"] === opt ? "bg-brand-info" : "bg-muted")}
                        onPress={() => setForm({ ...form, status: opt })}
                      >
                        <Text className={cn("text-[13px]", form["status"] === opt ? "text-white font-semibold" : "text-foreground")}>{opt}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              ) : (
                <View key={k}>
                  <Text className="mb-1 mt-2 text-xs font-semibold text-foreground">{k}</Text>
                  <Input
                    value={form[k] ?? ""}
                    onChangeText={(v) => setForm({ ...form, [k]: v })}
                    keyboardType={k === "quantity" || k === "remaining" ? "numeric" : "default"}
                  />
                </View>
              ),
            )}
            <Button className="mt-2.5" disabled={busy} onPress={() => void commit()}>
              <Text>{busy ? "…" : "Save"}</Text>
            </Button>
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
    <View className="rounded-lg border border-border bg-card p-3">
      <Text className="mb-2 text-base font-bold text-foreground">Clear flag</Text>
      <View className="flex-row items-center gap-2">
        <Input className="flex-1" value={epc} onChangeText={setEpc} placeholder="EPC" autoCapitalize="characters" />
        <Button variant="secondary" onPress={() => void run()}><Text>Clear</Text></Button>
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
    <View className="rounded-lg border border-border bg-card p-3">
      <Text className="mb-2 text-base font-bold text-foreground">Delete group</Text>
      <Text className="mb-1 mt-1 text-xs font-semibold text-foreground">Item type</Text>
      <View className="flex-row flex-wrap gap-1.5">
        {ITEM_TYPES.map((t) => (
          <Pressable key={t} className={cn("rounded-md px-3 py-1.5", itemType === t ? "bg-brand-info" : "bg-muted")} onPress={() => setItemType(t)}>
            <Text className={cn("text-[13px]", itemType === t ? "text-white font-semibold" : "text-foreground")}>{t}</Text>
          </Pressable>
        ))}
      </View>
      <Text className="mb-1 mt-2 text-xs font-semibold text-foreground">Group by</Text>
      <View className="flex-row flex-wrap gap-1.5">
        <Pressable className={cn("rounded-md px-3 py-1.5", groupBy === "bol" ? "bg-brand-info" : "bg-muted")} onPress={() => setGroupBy("bol")}>
          <Text className={cn("text-[13px]", groupBy === "bol" ? "text-white font-semibold" : "text-foreground")}>BOL</Text>
        </Pressable>
        <Pressable className={cn("rounded-md px-3 py-1.5", groupBy === "building" ? "bg-brand-info" : "bg-muted")} onPress={() => setGroupBy("building")}>
          <Text className={cn("text-[13px]", groupBy === "building" ? "text-white font-semibold" : "text-foreground")}>Building</Text>
        </Pressable>
      </View>
      <Text className="mb-1 mt-2 text-xs font-semibold text-foreground">Value</Text>
      <Input value={value} onChangeText={setValue} placeholder="BOL # / Building # / Item Name" />
      <Button variant="destructive" className="mt-2.5" onPress={confirm}>
        <Text>Delete group</Text>
      </Button>
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
    <View className="rounded-lg border border-border bg-card p-3">
      <Text className="mb-2 text-base font-bold text-foreground">Vendors</Text>
      {vendors.length === 0 ? (
        <Text className="text-sm italic text-muted-foreground">No vendors.</Text>
      ) : (
        vendors.map((v) => (
          <View key={v} className="flex-row items-center justify-between py-1.5">
            <Text className="text-[15px] text-foreground">{v}</Text>
            <Button variant="destructive" size="sm" onPress={() => onRemove(v)}><Text>Remove</Text></Button>
          </View>
        ))
      )}
    </View>
  );
}

/** Clear database with a double confirm. */
function ClearDbSection({ onConfirm }: { onConfirm: () => void }): React.ReactNode {
  return (
    <View className="rounded-lg border border-border bg-card p-3">
      <Text className="mb-2 text-base font-bold text-foreground">Danger zone</Text>
      <Button variant="destructive" onPress={onConfirm}>
        <Text>Clear database</Text>
      </Button>
    </View>
  );
}

/** Change the stored admin PIN (salted hash in the Keychain, not plaintext). */
function ChangePinSection({ onMsg }: { onMsg: (m: string) => void }): React.ReactNode {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (): Promise<void> => {
    const clean = pin.trim();
    if (clean.length < 4) {
      onMsg("PIN must be at least 4 digits.");
      return;
    }
    setBusy(true);
    try {
      await setAdminPin(clean);
      setPin("");
      onMsg("PIN updated.");
    } catch (err) {
      onMsg(err instanceof Error ? err.message : "Could not update PIN.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="rounded-lg border border-border bg-card p-3">
      <Text className="mb-2 text-base font-bold text-foreground">Change PIN</Text>
      <Input
        value={pin}
        onChangeText={setPin}
        placeholder="New PIN (4–8 digits)"
        secureTextEntry
        keyboardType="number-pad"
      />
      <Button className="mt-2.5" disabled={busy} onPress={() => void run()}><Text>{busy ? "…" : "Save PIN"}</Text></Button>
    </View>
  );
}
