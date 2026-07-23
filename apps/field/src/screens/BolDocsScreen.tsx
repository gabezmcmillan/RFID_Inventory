/**
 * BOL Documents screen (plan 007 step 4): newest-first list (`listBolDocs(0)`)
 * with linked box counts, and a detail view of page images + rename (updates
 * linked tags — the returned count is shown) + delete (admin PIN gate, from
 * plan 006). A cloud icon marks doc rows whose `storage_url` is non-empty (cheap
 * now, plan 010 needs it). The warehouse group rows link here with `?docId=…`
 * to open the detail directly.
 */

import {
  deleteBolDoc,
  getBolDoc,
  listBolDocs,
  renameBolDoc,
  type BolDoc,
  type BolDocWithBoxes,
} from "@rfid/domain";
import { useEffect, useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { Image, Pressable, ScrollView, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";

import { useDb } from "../db/provider";
import { pageImageUrisForDoc } from "../bol/documentStore";
import { PinPrompt } from "./adminPin";

export function BolDocsScreen(): React.ReactNode {
  const db = useDb();
  const params = useLocalSearchParams<{ docId?: string }>();
  const docId = params.docId ? Number(params.docId) : NaN;

  const [docs, setDocs] = useState<BolDocWithBoxes[]>([]);
  const [selected, setSelected] = useState<BolDoc | null>(null);

  const refreshList = async (): Promise<void> => {
    setDocs(await listBolDocs(db, 0));
  };

  const refreshDetail = async (id: number): Promise<void> => {
    setSelected(await getBolDoc(db, id));
  };

  useEffect(() => {
    void refreshList();
  }, [db]);

  useEffect(() => {
    if (Number.isFinite(docId)) {
      void refreshDetail(docId);
    } else {
      setSelected(null);
    }
  }, [db, docId]);

  if (selected) {
    return (
      <BolDocDetail
        doc={selected}
        onRenamed={() => void refreshDetail(selected.id)}
        onDeleted={async () => {
          await refreshList();
          router.setParams({ docId: "" });
        }}
      />
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 60, gap: 10 }}>
      {docs.length === 0 ? (
        <Text className="my-3 text-sm italic text-muted-foreground">No BOL documents yet. Capture one from Check In.</Text>
      ) : (
        docs.map((d) => (
          <Pressable
            key={d.id}
            className="mb-1.5 rounded-lg border border-border bg-card p-3"
            onPress={() => router.setParams({ docId: String(d.id) })}
          >
            <View className="flex-row items-center justify-between">
              <Text className="text-base font-semibold text-foreground">
                {d.storage_url ? "☁ " : ""}
                {d.bol_number || "(unnamed)"}
                {d.auto_named ? " · auto" : ""}
              </Text>
              <Text className="text-xs font-semibold text-muted-foreground">{d.boxes} box{d.boxes === 1 ? "" : "es"}</Text>
            </View>
            <Text className="mt-1 text-xs text-muted-foreground">
              {d.source} · {d.pages} page{d.pages === 1 ? "" : "s"}
              {d.vendor ? ` · ${d.vendor}` : ""}
              {d.po_number ? ` · PO ${d.po_number}` : ""}
            </Text>
          </Pressable>
        ))
      )}
    </ScrollView>
  );
}

/** Detail view: page images + rename + (PIN-gated) delete. */
function BolDocDetail({
  doc,
  onRenamed,
  onDeleted,
}: {
  doc: BolDoc;
  onRenamed: () => void;
  onDeleted: () => Promise<void>;
}): React.ReactNode {
  const db = useDb();
  const [rename, setRename] = useState(doc.bol_number);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const pageUris = pageImageUrisForDoc(doc);

  const onRename = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await renameBolDoc(db, doc.id, rename);
      setMsg(result.ok ? `${result.message} (${result.tags_updated ?? 0} box(es) updated)` : result.message);
      if (result.ok) onRenamed();
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await deleteBolDoc(db, doc.id);
      setMsg(result.message);
      if (result.ok) await onDeleted();
    } finally {
      setBusy(false);
      setConfirmingDelete(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 60, gap: 10 }}>
      <Text className="text-xl font-bold text-foreground">{doc.bol_number || "(unnamed)"}</Text>
      <Text className="text-[13px] text-muted-foreground">
        {doc.source} · {doc.pages} page{doc.pages === 1 ? "" : "s"}
        {doc.vendor ? ` · ${doc.vendor}` : ""}
        {doc.po_number ? ` · PO ${doc.po_number}` : ""}
        {doc.storage_url ? " · ☁ uploaded" : ""}
      </Text>

      {pageUris.length > 0 ? (
        <View className="my-2 gap-2.5">
          {pageUris.map((uri) => (
            <Image key={uri} source={{ uri }} className="h-65 w-full rounded-md border border-border" resizeMode="contain" />
          ))}
        </View>
      ) : (
        <Text className="my-3 text-sm italic text-muted-foreground">No page images to preview (uploaded PDF).</Text>
      )}

      <Text className="mt-2 text-sm font-semibold text-foreground">Rename BOL number</Text>
      <View className="flex-row items-center gap-2">
        <Input className="flex-1" value={rename} onChangeText={setRename} placeholder="BOL number" />
        <Button variant="secondary" disabled={busy} onPress={() => void onRename()}>
          <Text>Save</Text>
        </Button>
      </View>

      {confirmingDelete ? (
        <View className="rounded-lg border border-border bg-muted/40 p-2">
          <Text className="mt-2 text-sm font-semibold text-foreground">Enter admin PIN to delete</Text>
          <PinPrompt onUnlock={() => void onDelete()} />
        </View>
      ) : (
        <Button variant="destructive" className="mt-2.5" disabled={busy} onPress={() => setConfirmingDelete(true)}>
          <Text>Delete document</Text>
        </Button>
      )}

      {msg ? <Text className="mt-2 font-semibold text-primary">{msg}</Text> : null}
    </ScrollView>
  );
}
