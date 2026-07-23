/**
 * `FieldRow` — renders one {@link FieldDef} as the appropriate control:
 * `buttons`/`select` as a segmented chip row (vendor `select` also offers an
 * inline "+ add" that calls {@link onAddVendor}), and `text`/`date`/`number` as
 * a text input. Kept presentational; the owning screen owns the values.
 */

import { useState } from "react";
import { Pressable, View } from "react-native";

import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

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
      <View className="mb-3">
        <Text className="mb-1.5 text-sm font-semibold text-foreground">{field.label}</Text>
        <View className="flex-row flex-wrap gap-2">
          {options.map((opt) => (
            <Pressable
              key={opt}
              onPress={() => onChange(opt)}
              className={cn(
                "rounded-md px-3 py-2",
                value === opt ? "bg-primary" : "bg-muted",
              )}
            >
              <Text
                className={cn(
                  "text-sm",
                  value === opt ? "text-primary-foreground font-semibold" : "text-foreground",
                )}
              >
                {opt}
              </Text>
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
    <View className="mb-3">
      <Text className="mb-1.5 text-sm font-semibold text-foreground">{field.label}</Text>
      <Input
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
      <Pressable className="rounded-md bg-muted px-3 py-2" onPress={() => setAdding(true)}>
        <Text className="text-sm text-foreground">+ add</Text>
      </Pressable>
    );
  }
  return (
    <View className="flex-row items-center gap-1.5">
      <Input
        autoFocus
        value={name}
        onChangeText={setName}
        placeholder="vendor name"
        className="w-30 py-1"
      />
      <Pressable
        className="rounded-md bg-muted px-3 py-2"
        onPress={async () => {
          const trimmed = name.trim();
          if (trimmed) await onAdd(trimmed);
          setName("");
          setAdding(false);
        }}
      >
        <Text className="text-sm text-foreground">save</Text>
      </Pressable>
    </View>
  );
}
