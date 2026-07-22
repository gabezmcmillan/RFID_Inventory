/**
 * Check In screen — the full scan path: setup (arm a shipment) → scanning
 * (per-unit fields + trigger pulls → result cards) → amend / note / end.
 *
 * Setup starts with the document step (plan 007): [Scan BOL] [Upload] [Recent
 * docs] [Skip]. Capture/upload/pick prefills `bol_number` / `po_number` /
 * `vendor` (editable; vendor only when it matched the table) and stashes
 * `bol_doc_id` into the armed fields; "Add page" re-runs extraction. In the
 * scanning phase, a doc carrying `line_items` renders them as one-tap chips that
 * prefill the per-unit Item No. / Item Name / Quantity via
 * {@link intakeSession.setItemFields}.
 *
 * State machine: `setup` collects the item type and shipment fields, `scanning`
 * arms the {@link intakeSession} and the reader (`checkin` mode) and appends a
 * result card per `scan` event. Leaving or ending disarms and returns the reader
 * to `idle` (app.py:944-947). All SQL stays in `@rfid/domain`.
 */

import {
  addNote,
  addVendor,
  ITEM_TYPES,
  itemNameSuggestions,
  listBolDocs,
  listVendors,
  NAMED_ITEM_TYPES,
  TYPE_FIELDS,
  type BolDoc,
  type BolLineItem,
  type FieldDef,
  type ItemFields,
} from "@rfid/domain";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import {
  addPageToBolDocument,
  captureBolDocument,
  uploadBolDocument,
  useMistralApiKey,
  type CaptureDeps,
} from "../../bol/documentStore";
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
  const { key: mistralKey } = useMistralApiKey();
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

  // BOL document step (plan 007).
  const [bolDocId, setBolDocId] = useState<number | null>(null);
  const [bolDocFilename, setBolDocFilename] = useState("");
  const [lineItems, setLineItems] = useState<BolLineItem[]>([]);
  const [recentDocs, setRecentDocs] = useState<BolDoc[]>([]);
  const [showRecent, setShowRecent] = useState(false);
  const [capturing, setCapturing] = useState(false);

  const typeFields = TYPE_FIELDS[itemType] ?? [];
  const shipmentFields = typeFields.filter((f) => f.scope === "shipment");
  const itemFields = typeFields.filter((f) => f.scope === "item");
  const isNamed = NAMED_ITEM_TYPES.includes(itemType);
  const canAddPage = bolDocId !== null && /_p\d+\.jpg$/.test(bolDocFilename);

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

  const captureDeps: CaptureDeps = { mistralApiKey: mistralKey, vendors, fetchImpl: undefined };

  /** Prefill the shipment fields from a captured/picked doc and stash its id + line items. */
  const applyDoc = (doc: BolDoc): void => {
    setShipment((prev) => ({
      ...prev,
      bol_number: doc.bol_number || prev.bol_number || "",
      po_number: doc.po_number || prev.po_number || "",
      vendor: doc.vendor || prev.vendor || "",
      bol_doc_id: String(doc.id),
    }));
    setBolDocId(doc.id);
    setBolDocFilename(doc.filename);
    setLineItems(doc.line_items);
  };

  const onScanBol = async (): Promise<void> => {
    if (capturing) return;
    setCapturing(true);
    try {
      const doc = await captureBolDocument(db, captureDeps);
      if (doc) applyDoc(doc);
    } finally {
      setCapturing(false);
    }
  };

  const onUploadBol = async (): Promise<void> => {
    if (capturing) return;
    setCapturing(true);
    try {
      const doc = await uploadBolDocument(db, captureDeps);
      if (doc) applyDoc(doc);
    } finally {
      setCapturing(false);
    }
  };

  const onAddPage = async (): Promise<void> => {
    if (capturing || bolDocId === null) return;
    setCapturing(true);
    try {
      const doc = await addPageToBolDocument(db, bolDocId, captureDeps);
      if (doc) applyDoc(doc);
    } finally {
      setCapturing(false);
    }
  };

  const onPickRecent = (doc: BolDoc): void => {
    applyDoc(doc);
    setShowRecent(false);
  };

  const onSkip = (): void => {
    setBolDocId(null);
    setBolDocFilename("");
    setLineItems([]);
    setShipment((prev) => {
      const { bol_doc_id: _drop, ...rest } = prev;
      return rest;
    });
  };

  const openRecent = async (): Promise<void> => {
    setRecentDocs(await listBolDocs(db, 15));
    setShowRecent(true);
  };

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

  /** Prefill the per-unit fields from a tapped line-item chip (plan 007). */
  const onPickLineItem = (li: BolLineItem): void => {
    const next = { ...item, sku: li.item_no, item_name: li.item_name, quantity: li.quantity };
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
        <Text style={styles.sectionLabel}>BOL document</Text>
        <View style={styles.docBtnRow}>
          <Pressable style={[styles.docBtn, capturing && styles.btnDisabled]} disabled={capturing} onPress={() => void onScanBol()}>
            <Text style={styles.docBtnText}>{capturing ? "Scanning…" : "Scan BOL"}</Text>
          </Pressable>
          <Pressable style={styles.docBtn} onPress={() => void onUploadBol()}>
            <Text style={styles.docBtnText}>Upload</Text>
          </Pressable>
          <Pressable style={styles.docBtn} onPress={() => void openRecent()}>
            <Text style={styles.docBtnText}>Recent</Text>
          </Pressable>
          <Pressable style={styles.docBtnSkip} onPress={onSkip}>
            <Text style={styles.docBtnSkipText}>Skip</Text>
          </Pressable>
        </View>
        {bolDocId !== null ? (
          <Text style={styles.docStatus}>
            Linked: {(shipment.bol_number ?? "") || "(unnamed)"}
            {canAddPage ? (
              <Text style={styles.addPageLink} onPress={() => void onAddPage()}>  · Add page</Text>
            ) : null}
          </Text>
        ) : (
          <Text style={styles.hint}>Skip if the BOL isn't ready; you can type the numbers below.</Text>
        )}

        {showRecent ? (
          <View style={styles.recentList}>
            {recentDocs.length === 0 ? (
              <Text style={styles.hint}>No recent documents.</Text>
            ) : (
              recentDocs.map((d) => (
                <Pressable key={d.id} style={styles.recentRow} onPress={() => onPickRecent(d)}>
                  <Text style={styles.recentRef}>{d.bol_number || "(unnamed)"}</Text>
                  <Text style={styles.recentMeta}>{d.pages}p · {d.source}{d.vendor ? ` · ${d.vendor}` : ""}</Text>
                </Pressable>
              ))
            )}
          </View>
        ) : null}

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

      {lineItems.length > 0 ? (
        <View style={styles.lineItemsBlock}>
          <Text style={styles.sectionLabel}>Line items (tap to prefill)</Text>
          <View style={styles.suggestRow}>
            {lineItems.map((li, i) => (
              <Pressable
                key={`${li.item_no}-${i}`}
                style={styles.lineItemChip}
                onPress={() => onPickLineItem(li)}
              >
                <Text style={styles.lineItemText}>
                  {li.item_no || "—"}{li.item_name ? ` · ${li.item_name}` : ""}{li.quantity ? ` (${li.quantity})` : ""}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

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
  docBtnRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginVertical: 8 },
  docBtn: { backgroundColor: "#06c", paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8 },
  docBtnSkip: { backgroundColor: "#eee", paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8 },
  docBtnText: { color: "white", fontWeight: "600" },
  docBtnSkipText: { color: "#333", fontWeight: "600" },
  btnDisabled: { backgroundColor: "#9ab" },
  docStatus: { fontSize: 13, color: "#0a7", fontWeight: "600", marginTop: 4 },
  addPageLink: { color: "#06c", fontWeight: "700" },
  recentList: { borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 8, backgroundColor: "#fafafa", marginVertical: 8 },
  recentRow: { paddingVertical: 8, borderBottomWidth: 1, borderColor: "#eee" },
  recentRef: { fontSize: 15, fontWeight: "600" },
  recentMeta: { fontSize: 12, color: "#666", marginTop: 2 },
  lineItemsBlock: { marginVertical: 8 },
  lineItemChip: { backgroundColor: "#eef", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6 },
  lineItemText: { fontSize: 12, color: "#336" },
});


