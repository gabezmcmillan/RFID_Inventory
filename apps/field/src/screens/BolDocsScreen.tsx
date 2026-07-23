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
import { Image, Platform, Pressable, ScrollView, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";

import { useDb } from "../db/provider";
import { pageImageUrisForDoc } from "../bol/documentStore";
import { PinPrompt } from "./adminPin";

export function BolDocsScreen(): React.ReactNode {
  const db = useDb();
  const params = useLocalSearchParams<{ docId?: string }>();
  const docId = params.docId ?? "";

  const [docs, setDocs] = useState<BolDocWithBoxes[]>([]);
  const [selected, setSelected] = useState<BolDoc | null>(null);

  const refreshList = async (): Promise<void> => {
    setDocs(await listBolDocs(db, 0));
  };

  const refreshDetail = async (id: string): Promise<void> => {
    setSelected(await getBolDoc(db, id));
  };

  useEffect(() => {
    void refreshList();
  }, [db]);

  useEffect(() => {
    if (docId) {
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
        <View className="mt-2 rounded-xl border border-dashed border-border bg-muted/30 p-4">
          <Text className="text-sm font-semibold text-foreground">No BOL documents yet</Text>
          <Text className="mt-0.5 text-sm text-muted-foreground">Capture one from the Check In screen to get started.</Text>
        </View>
      ) : (
        docs.map((d) => (
          <Pressable
            key={d.id}
            className="rounded-xl border border-border bg-card p-3.5 active:opacity-70"
            onPress={() => router.setParams({ docId: String(d.id) })}
          >
            <View className="flex-row items-center justify-between">
              <Text className="flex-1 text-base font-bold text-foreground">
                {d.storage_url ? "☁ " : ""}
                {d.bol_number || "(unnamed)"}
                {d.auto_named ? " · auto" : ""}
              </Text>
              <Text className="font-mono text-xs font-semibold tabular-nums text-muted-foreground">{d.boxes} box{d.boxes === 1 ? "" : "es"}</Text>
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
    <ScrollView
      contentContainerStyle={{ padding: 20, paddingBottom: 60, gap: 10 }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
    >
      <Text className="text-2xl font-bold text-brand-navy">{doc.bol_number || "(unnamed)"}</Text>
      <Text className="text-[13px] text-muted-foreground">
        {doc.source} · {doc.pages} page{doc.pages === 1 ? "" : "s"}
        {doc.vendor ? ` · ${doc.vendor}` : ""}
        {doc.po_number ? ` · PO ${doc.po_number}` : ""}
        {doc.storage_url ? " · ☁ uploaded" : ""}
      </Text>

      {pageUris.length > 0 ? (
        <View className="my-2 gap-2.5">
          {pageUris.map((uri) => (
            <Image key={uri} source={{ uri }} className="h-65 w-full rounded-lg border border-border" resizeMode="contain" />
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
        <View className="rounded-xl border border-destructive bg-destructive/10 p-3">
          <Text className="text-sm font-semibold text-destructive">Enter admin PIN to delete</Text>
          <PinPrompt centered={false} onUnlock={() => void onDelete()} />
        </View>
      ) : (
        <Button variant="destructive" className="mt-3" disabled={busy} onPress={() => setConfirmingDelete(true)}>
          <Text>Delete document</Text>
        </Button>
      )}

      {msg ? <Text className="mt-2 font-semibold text-primary">{msg}</Text> : null}
    </ScrollView>
  );
}
