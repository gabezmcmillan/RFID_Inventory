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
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

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
    <ScrollView contentContainerStyle={styles.container}>
      {docs.length === 0 ? (
        <Text style={styles.hint}>No BOL documents yet. Capture one from Check In.</Text>
      ) : (
        docs.map((d) => (
          <Pressable
            key={d.id}
            style={styles.docRow}
            onPress={() => router.setParams({ docId: String(d.id) })}
          >
            <View style={styles.docHead}>
              <Text style={styles.docRef}>
                {d.storage_url ? "☁ " : ""}
                {d.bol_number || "(unnamed)"}
                {d.auto_named ? " · auto" : ""}
              </Text>
              <Text style={styles.docBoxes}>{d.boxes} box{d.boxes === 1 ? "" : "es"}</Text>
            </View>
            <Text style={styles.docMeta}>
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
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>{doc.bol_number || "(unnamed)"}</Text>
      <Text style={styles.meta}>
        {doc.source} · {doc.pages} page{doc.pages === 1 ? "" : "s"}
        {doc.vendor ? ` · ${doc.vendor}` : ""}
        {doc.po_number ? ` · PO ${doc.po_number}` : ""}
        {doc.storage_url ? " · ☁ uploaded" : ""}
      </Text>

      {pageUris.length > 0 ? (
        <View style={styles.pages}>
          {pageUris.map((uri, i) => (
            <Image key={uri} source={{ uri }} style={styles.pageImage} resizeMode="contain" />
          ))}
        </View>
      ) : (
        <Text style={styles.hint}>No page images to preview (uploaded PDF).</Text>
      )}

      <Text style={styles.sectionLabel}>Rename BOL number</Text>
      <View style={styles.row}>
        <TextInput style={styles.input} value={rename} onChangeText={setRename} placeholder="BOL number" />
        <Pressable style={[styles.miniBtn, busy && styles.btnDisabled]} disabled={busy} onPress={() => void onRename()}>
          <Text style={styles.miniBtnText}>Save</Text>
        </Pressable>
      </View>

      {confirmingDelete ? (
        <View style={styles.pinBox}>
          <Text style={styles.sectionLabel}>Enter admin PIN to delete</Text>
          <PinPrompt onUnlock={() => void onDelete()} />
        </View>
      ) : (
        <Pressable style={[styles.primary, styles.danger]} disabled={busy} onPress={() => setConfirmingDelete(true)}>
          <Text style={styles.primaryText}>Delete document</Text>
        </Pressable>
      )}

      {msg ? <Text style={styles.msg}>{msg}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingBottom: 60, gap: 10 },
  title: { fontSize: 20, fontWeight: "bold" },
  meta: { fontSize: 13, color: "#666" },
  hint: { color: "#888", fontStyle: "italic", marginVertical: 12 },
  docRow: { borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 12, backgroundColor: "white", marginBottom: 6 },
  docHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  docRef: { fontSize: 16, fontWeight: "600" },
  docBoxes: { fontSize: 12, color: "#555", fontWeight: "600" },
  docMeta: { fontSize: 12, color: "#666", marginTop: 4 },
  pages: { gap: 10, marginVertical: 8 },
  pageImage: { width: "100%", height: 260, borderRadius: 6, borderWidth: 1, borderColor: "#eee" },
  sectionLabel: { fontSize: 14, fontWeight: "600", marginTop: 8, color: "#333" },
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  input: { flex: 1, borderWidth: 1, borderColor: "#ccc", borderRadius: 6, padding: 10, fontSize: 16 },
  miniBtn: { paddingHorizontal: 16, paddingVertical: 12, backgroundColor: "#555", borderRadius: 6 },
  miniBtnText: { color: "white", fontWeight: "600" },
  primary: { backgroundColor: "#0a7", padding: 14, borderRadius: 8, alignItems: "center", marginTop: 10 },
  primaryText: { color: "white", fontWeight: "600" },
  danger: { backgroundColor: "#c33" },
  btnDisabled: { backgroundColor: "#9ab" },
  pinBox: { borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 8, backgroundColor: "#fafafa" },
  msg: { color: "#0a7", fontWeight: "600", marginTop: 8 },
});
