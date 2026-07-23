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
import { Platform, Pressable, ScrollView, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

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
  const [bolDocId, setBolDocId] = useState<string | null>(null);
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
      <ScrollView
        contentContainerStyle={{ padding: 20, paddingBottom: 60, gap: 4 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
      >
        <Text className="mt-2 text-sm font-bold text-brand-navy">BOL document</Text>
        <View className="my-2 flex-row flex-wrap gap-2">
          <Button size="lg" disabled={capturing} onPress={() => void onScanBol()}>
            <Text>{capturing ? "Scanning…" : "Scan BOL"}</Text>
          </Button>
          <Button size="lg" variant="secondary" onPress={() => void onUploadBol()}>
            <Text>Upload</Text>
          </Button>
          <Button size="lg" variant="secondary" onPress={() => void openRecent()}>
            <Text>Recent</Text>
          </Button>
          <Button size="lg" variant="secondary" onPress={onSkip}>
            <Text>Skip</Text>
          </Button>
        </View>
        {bolDocId !== null ? (
          <Text className="mt-1 text-[13px] font-semibold text-primary">
            Linked: {(shipment.bol_number ?? "") || "(unnamed)"}
            {canAddPage ? (
              <Text className="font-bold text-brand-info" onPress={() => void onAddPage()}>  · Add page</Text>
            ) : null}
          </Text>
        ) : (
          <Text className="my-3 text-sm italic text-muted-foreground">Skip if the BOL isn't ready; you can type the numbers below.</Text>
        )}

        {showRecent ? (
          <View className="my-2 rounded-lg border border-border bg-muted/40 p-2">
            {recentDocs.length === 0 ? (
              <Text className="text-sm italic text-muted-foreground">No recent documents.</Text>
            ) : (
              recentDocs.map((d) => (
                <Pressable
                  key={d.id}
                  className="border-b border-border py-2"
                  onPress={() => onPickRecent(d)}
                >
                  <Text className="text-[15px] font-semibold text-foreground">{d.bol_number || "(unnamed)"}</Text>
                  <Text className="mt-0.5 text-xs text-muted-foreground">{d.pages}p · {d.source}{d.vendor ? ` · ${d.vendor}` : ""}</Text>
                </Pressable>
              ))
            )}
          </View>
        ) : null}

        <Text className="mt-2 text-sm font-bold text-brand-navy">Item type</Text>
        <View className="my-2 flex-row flex-wrap gap-2">
          {ITEM_TYPES.map((t) => (
            <Pressable
              key={t}
              onPress={() => setItemType(t)}
              className={cn("rounded-lg px-3.5 py-2.5 active:opacity-70", itemType === t ? "bg-primary" : "bg-muted")}
            >
              <Text
                className={cn(
                  "text-sm",
                  itemType === t ? "text-primary-foreground font-semibold" : "text-foreground",
                )}
              >
                {t}
              </Text>
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

        <Button size="lg" className="mt-4" onPress={startCheckIn}>
          <Text className="text-lg font-semibold">Start check-in</Text>
        </Button>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={{ padding: 20, paddingBottom: 60, gap: 4 }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
    >
      <View className="mb-3 flex-row items-center justify-between rounded-xl border border-border bg-card p-3">
        <Text className="flex-1 text-base font-bold text-brand-navy">
          {itemType} · BOL {shipment.bol_number ?? ""} · Bldg {shipment.building_number ?? ""}
        </Text>
        <Button variant="destructive" onPress={endCheckIn}>
          <Text>End</Text>
        </Button>
      </View>

      {lineItems.length > 0 ? (
        <View className="my-2">
          <Text className="text-sm font-semibold text-foreground">Line items (tap to prefill)</Text>
          <View className="mb-3 mt-1.5 flex-row flex-wrap gap-1.5">
            {lineItems.map((li, i) => (
              <Pressable
                key={`${li.item_no}-${i}`}
                className="rounded-md bg-brand-info/15 px-2.5 py-1.5"
                onPress={() => onPickLineItem(li)}
              >
                <Text className="text-xs text-brand-info">
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
            <View className="mb-3 flex-row flex-wrap gap-1.5">
              {suggestions.map((s) => (
                <Pressable
                  key={s}
                  className="rounded-md bg-brand-info/15 px-2 py-1"
                  onPress={() => onItemFieldChange("item_name", s)}
                >
                  <Text className="text-xs text-brand-info">{s}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
      ))}

      {results.length === 0 ? (
        <View className="my-3 rounded-xl border border-dashed border-border bg-muted/30 p-4">
          <Text className="text-sm text-muted-foreground">Pull the trigger to scan a box…</Text>
        </View>
      ) : (
        results.map((entry, i) => (
          <ResultCard key={`${entry.epc}-${i}`} entry={entry} newest={i === results.length - 1} onAmend={setAmendEpc} />
        ))
      )}

      {printingEnabled(printer) ? (
        <View className="mt-4 flex-row flex-wrap items-center gap-2.5">
          <Text className="text-sm font-semibold text-foreground">Print &amp; encode labels</Text>
          <View className="flex-row items-center gap-2">
            <Button size="icon" variant="secondary" onPress={() => adjustPrintCount(-1)}>
              <Text>−</Text>
            </Button>
            <Text className="min-w-7 text-center text-base font-semibold">{printCount}</Text>
            <Button size="icon" variant="secondary" onPress={() => adjustPrintCount(1)}>
              <Text>+</Text>
            </Button>
          </View>
          <Button disabled={printing} onPress={() => void onPrintLabels()}>
            <Text>{printing ? "Printing…" : `Print ${printCount} label${printCount === 1 ? "" : "s"}`}</Text>
          </Button>
        </View>
      ) : null}

      <View className="mt-4 flex-row gap-2">
        <Input
          className="flex-1"
          value={noteText}
          onChangeText={setNoteText}
          placeholder="Add a note…"
        />
        <Button variant="secondary" onPress={onAddNote}>
          <Text>Add</Text>
        </Button>
      </View>

      {__DEV__ ? (
        <Button
          variant="secondary"
          className="mt-4"
          onPress={() => readerService.injectScan([randomEpc()])}
        >
          <Text>Simulate scan</Text>
        </Button>
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


