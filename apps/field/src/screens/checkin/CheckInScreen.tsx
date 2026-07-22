/**
 * Check In screen — the full scan path: setup (arm a shipment) → scanning
 * (per-unit fields + trigger pulls → result cards) → amend / note / end.
 *
 * State machine: `setup` collects the item type and shipment fields, `scanning`
 * arms the {@link intakeSession} and the reader (`checkin` mode) and appends a
 * result card per `scan` event. Leaving or ending disarms and returns the
 * reader to `idle` (app.py:944-947 — any non-checkin mode disarms). All SQL
 * stays in `@rfid/domain`; this screen only calls repos and the session.
 */

import {
  addNote,
  addVendor,
  ITEM_TYPES,
  itemNameSuggestions,
  listVendors,
  NAMED_ITEM_TYPES,
  TYPE_FIELDS,
  type FieldDef,
  type ItemFields,
} from "@rfid/domain";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { useDb } from "../../db/provider";
import { useReaderEvents } from "../../hooks/useReaderEvents";
import { readerService } from "../../reader/readerService";
import { intakeSession } from "../../intake/session";
import { sendZpl, PRINTER_PORT } from "../../printer/printerClient";
import {
  loadPrinterSettings,
  printingEnabled,
  type PrinterSettings,
} from "../../printer/printerSettings";
import { AmendSheet } from "./AmendSheet";
import { FieldRow } from "./FieldRow";
import { ResultCard, type CheckInResult } from "./ResultCard";

type Phase = "setup" | "scanning";

/** Convert the per-unit form values to an {@link ItemFields} for the session. */
function toItemFields(form: Record<string, string>): ItemFields {
  const qty = form.quantity?.trim();
  return {
    item_name: form.item_name || undefined,
    sku: form.sku || undefined,
    mfc_date: form.mfc_date || undefined,
    quantity: qty === undefined || qty === "" ? undefined : Number(qty),
  };
}

/** A 24-hex-char EPC for the dev "simulate scan" button. */
function randomEpc(): string {
  const hex = "0123456789ABCDEF";
  let s = "";
  for (let i = 0; i < 24; i++) s += hex[Math.floor(Math.random() * 16)];
  return s;
}

export function CheckInScreen(): React.ReactNode {
  const db = useDb();
  const [phase, setPhase] = useState<Phase>("setup");
  const [itemType, setItemType] = useState<string>(ITEM_TYPES[0] ?? "");
  const [shipment, setShipment] = useState<Record<string, string>>({});
  const [item, setItem] = useState<Record<string, string>>({});
  const [vendors, setVendors] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [results, setResults] = useState<CheckInResult[]>([]);
  const [amendEpc, setAmendEpc] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [printer, setPrinter] = useState<PrinterSettings>({ printerHost: "", cloudBaseUrl: "" });
  const [printCount, setPrintCount] = useState(1);
  const [printing, setPrinting] = useState(false);

  const typeFields = TYPE_FIELDS[itemType] ?? [];
  const shipmentFields = typeFields.filter((f) => f.scope === "shipment");
  const itemFields = typeFields.filter((f) => f.scope === "item");
  const isNamed = NAMED_ITEM_TYPES.includes(itemType);

  // Load vendors + item-name suggestions for the current item type.
  useEffect(() => {
    void listVendors(db).then(setVendors);
  }, [db]);
  useEffect(() => {
    if (!isNamed) {
      setSuggestions([]);
      return;
    }
    void (async () => {
      setSuggestions(await itemNameSuggestions(db, itemType));
    })();
  }, [db, itemType, isNamed]);

  // Scan handler: record one trigger-pull EPC under the armed shipment.
  useReaderEvents((event) => {
    if (event.event !== "scan" || event.mode !== "checkin") return;
    void (async () => {
      const result = await intakeSession.checkInScanned(db, event.epc);
      setResults((prev) => [
        ...prev,
        { epc: event.epc, result, duplicate: result.ok && "added" in result && result.added === 0 },
      ]);
    })();
  });

  // Load printer settings (printer_host empty → printing disabled, button hidden).
  useEffect(() => {
    void loadPrinterSettings().then(setPrinter);
  }, []);

  // Leaving the screen disarms and idles the reader (app.py:944-947).
  useEffect(() => {
    return () => {
      intakeSession.disarm();
      readerService.setMode("idle");
    };
  }, []);

  const startCheckIn = (): void => {
    intakeSession.arm(itemType, shipment);
    intakeSession.setItemFields(toItemFields(item));
    readerService.setMode("checkin");
    setPhase("scanning");
  };

  const endCheckIn = (): void => {
    intakeSession.disarm();
    readerService.setMode("idle");
    setPhase("setup");
    setResults([]);
  };

  const onItemFieldChange = (key: string, value: string): void => {
    const next = { ...item, [key]: value };
    setItem(next);
    intakeSession.setItemFields(toItemFields(next));
  };

  const onAddVendor = async (name: string): Promise<void> => {
    await addVendor(db, name);
    setVendors(await listVendors(db));
  };

  const onAmend = async (epc: string, fields: ItemFields): Promise<void> => {
    await intakeSession.amend(db, epc, fields);
  };

  const onAddNote = async (): Promise<void> => {
    if (!noteText.trim()) return;
    await addNote(db, itemType, shipment.bol_number ?? "", shipment.building_number ?? "", noteText.trim());
    setNoteText("");
  };

  const onPrintLabels = async (): Promise<void> => {
    const host = printer.printerHost.trim();
    if (!host || printing) return;
    setPrinting(true);
    try {
      const result = await intakeSession.checkInPrinted(
        db,
        { cloudBaseUrl: printer.cloudBaseUrl, printLabel: (zpl) => sendZpl(host, PRINTER_PORT, zpl) },
        printCount,
      );
      const epc = result.ok ? result.epc : "";
      setResults((prev) => [...prev, { epc, result, duplicate: false }]);
    } finally {
      setPrinting(false);
    }
  };

  const adjustPrintCount = (delta: number): void => {
    setPrintCount((n) => Math.min(25, Math.max(1, n + delta)));
  };

  if (phase === "setup") {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.sectionLabel}>Item type</Text>
        <View style={styles.chips}>
          {ITEM_TYPES.map((t) => (
            <Pressable
              key={t}
              onPress={() => setItemType(t)}
              style={[styles.chip, itemType === t && styles.chipActive]}
            >
              <Text style={[styles.chipText, itemType === t && styles.chipTextActive]}>{t}</Text>
            </Pressable>
          ))}
        </View>

        {shipmentFields.map((f: FieldDef) => (
          <FieldRow
            key={f.key}
            field={f}
            value={shipment[f.key] ?? ""}
            onChange={(v) => setShipment({ ...shipment, [f.key]: v })}
            vendors={vendors}
            onAddVendor={onAddVendor}
          />
        ))}

        <Pressable style={styles.primary} onPress={startCheckIn}>
          <Text style={styles.primaryText}>Start check-in</Text>
        </Pressable>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.armedBar}>
        <Text style={styles.armedText}>
          {itemType} · BOL {shipment.bol_number ?? ""} · Bldg {shipment.building_number ?? ""}
        </Text>
        <Pressable onPress={endCheckIn} style={styles.endBtn}>
          <Text style={styles.endBtnText}>End</Text>
        </Pressable>
      </View>

      {itemFields.map((f: FieldDef) => (
        <View key={f.key}>
          <FieldRow field={f} value={item[f.key] ?? ""} onChange={(v) => onItemFieldChange(f.key, v)} />
          {f.suggest && suggestions.length > 0 ? (
            <View style={styles.suggestRow}>
              {suggestions.map((s) => (
                <Pressable key={s} onPress={() => onItemFieldChange("item_name", s)} style={styles.suggestChip}>
                  <Text style={styles.suggestText}>{s}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
      ))}

      {results.length === 0 ? (
        <Text style={styles.hint}>Pull the trigger to scan a box…</Text>
      ) : (
        results.map((entry, i) => (
          <ResultCard key={`${entry.epc}-${i}`} entry={entry} newest={i === results.length - 1} onAmend={setAmendEpc} />
        ))
      )}

      {printingEnabled(printer) ? (
        <View style={styles.printRow}>
          <Text style={styles.printLabel}>Print &amp; encode labels</Text>
          <View style={styles.stepper}>
            <Pressable style={styles.stepBtn} onPress={() => adjustPrintCount(-1)}>
              <Text style={styles.stepText}>−</Text>
            </Pressable>
            <Text style={styles.printCount}>{printCount}</Text>
            <Pressable style={styles.stepBtn} onPress={() => adjustPrintCount(1)}>
              <Text style={styles.stepText}>+</Text>
            </Pressable>
          </View>
          <Pressable style={[styles.printBtn, printing && styles.printBtnDisabled]} disabled={printing} onPress={() => void onPrintLabels()}>
            <Text style={styles.printBtnText}>{printing ? "Printing…" : `Print ${printCount} label${printCount === 1 ? "" : "s"}`}</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.noteRow}>
        <TextInput style={styles.noteInput} value={noteText} onChangeText={setNoteText} placeholder="Add a note…" />
        <Pressable style={styles.noteBtn} onPress={onAddNote}>
          <Text style={styles.noteBtnText}>Add</Text>
        </Pressable>
      </View>

      {__DEV__ ? (
        <Pressable style={styles.simBtn} onPress={() => readerService.injectScan([randomEpc()])}>
          <Text style={styles.simBtnText}>Simulate scan</Text>
        </Pressable>
      ) : null}

      <AmendSheet
        epc={amendEpc}
        initial={toItemFields(item)}
        onAmend={onAmend}
        onClose={() => setAmendEpc(null)}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingBottom: 60, gap: 4 },
  sectionLabel: { fontSize: 14, fontWeight: "600", marginTop: 8, color: "#333" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginVertical: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6, backgroundColor: "#eee" },
  chipActive: { backgroundColor: "#0a7" },
  chipText: { fontSize: 14, color: "#333" },
  chipTextActive: { color: "white", fontWeight: "600" },
  primary: { backgroundColor: "#0a7", padding: 16, borderRadius: 8, alignItems: "center", marginTop: 16 },
  primaryText: { color: "white", fontSize: 18, fontWeight: "600" },
  armedBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  armedText: { fontSize: 16, fontWeight: "600" },
  endBtn: { backgroundColor: "#c33", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6 },
  endBtnText: { color: "white", fontWeight: "600" },
  suggestRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 12 },
  suggestChip: { backgroundColor: "#eef", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  suggestText: { fontSize: 12, color: "#336" },
  hint: { color: "#888", fontStyle: "italic", marginVertical: 12 },
  noteRow: { flexDirection: "row", gap: 8, marginTop: 16 },
  noteInput: { flex: 1, borderWidth: 1, borderColor: "#ccc", borderRadius: 6, padding: 10, fontSize: 16 },
  noteBtn: { backgroundColor: "#555", paddingHorizontal: 16, justifyContent: "center", borderRadius: 6 },
  noteBtnText: { color: "white", fontWeight: "600" },
  simBtn: { backgroundColor: "#eee", padding: 12, borderRadius: 8, alignItems: "center", marginTop: 16 },
  simBtnText: { color: "#333", fontWeight: "600" },
  printRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 16, flexWrap: "wrap" },
  printLabel: { fontSize: 14, fontWeight: "600", color: "#333" },
  stepper: { flexDirection: "row", alignItems: "center", gap: 8 },
  stepBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: "#eee", alignItems: "center", justifyContent: "center" },
  stepText: { fontSize: 20, fontWeight: "600" },
  printCount: { fontSize: 16, fontWeight: "600", minWidth: 28, textAlign: "center" },
  printBtn: { backgroundColor: "#06c", paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8 },
  printBtnDisabled: { backgroundColor: "#9ab" },
  printBtnText: { color: "white", fontWeight: "600" },
});
