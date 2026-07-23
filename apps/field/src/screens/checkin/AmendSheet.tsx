/**
 * `AmendSheet` — operator correction of the just-scanned tag. Edits the four
 * amendable fields (Item Name / Item No. / mfc date / qty) and calls
 * {@link onAmend}; the domain `IntakeSession.amend` drops any other keys.
 */

import { useEffect, useState } from "react";
import { Modal, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";

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
      <View className="flex-1 justify-end bg-black/40">
        <View className="gap-2 rounded-t-2xl bg-background p-5">
          <Text className="text-xl font-bold">Amend tag</Text>
          <Text className="mb-2 font-mono text-xs text-muted-foreground">{epc ?? ""}</Text>
          <Field label="Item Name" value={form.item_name} onChange={(v) => setForm({ ...form, item_name: v })} />
          <Field label="Item No." value={form.sku} onChange={(v) => setForm({ ...form, sku: v })} />
          <Field label="Mfc date" value={form.mfc_date} onChange={(v) => setForm({ ...form, mfc_date: v })} />
          <Field label="Quantity" value={form.quantity} onChange={(v) => setForm({ ...form, quantity: v })} numeric />
          <View className="mt-2 flex-row justify-end gap-3">
            <Button variant="ghost" onPress={onClose}>
              <Text>Cancel</Text>
            </Button>
            <Button
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
              <Text>Save</Text>
            </Button>
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
    <View className="mb-2.5">
      <Text className="mb-1 text-sm font-semibold text-foreground">{label}</Text>
      <Input
        value={value}
        onChangeText={onChange}
        keyboardType={numeric ? "numeric" : "default"}
      />
    </View>
  );
}
