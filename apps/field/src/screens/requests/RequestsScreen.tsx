/**
 * Requests screen — the warehouse manager's view of material requests
 * (db.py:1459-1521, app.py:486-542). Cards are ordered open-first (staging,
 * then pending, then the rest, newest-first within) by `listRequests`, and
 * grouped visually when consecutive lines share an `order_ref` (one cart
 * order). A tap opens a detail sheet with the full fields and the actions
 * available for the request's status (derived via {@link requestActions} — no
 * status strings hard-coded here):
 *   pending  → Fulfill / Decline
 *   staging → Resume staging / Cancel staging / Decline
 *   resolved → read-only with handler_note
 *
 * Decline calls `setRequestStatus(id, "declined", note)`; Fulfill/Resume
 * set `staging` and open Check Out in staging mode; Cancel staging returns
 * `pending`. Every mutation calls `notifyRequestsChanged` (refreshes the home
 * badge + this list) and the no-op `syncNow` (plan 010 replaces it).
 */

import {
  listRequests,
  setRequestStatus,
  type MaterialRequest,
} from "@rfid/domain";
import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { useDb } from "../../db/provider";
import { syncNow } from "../../sync/syncNow";
import { notifyRequestsChanged, subscribeRequestsChanged } from "./refresh";
import { requestActions } from "./requestActions";

const STATUS_COLORS: Record<string, string> = {
  pending: "#e6a700",
  staging: "#06c",
  fulfilled: "#0a7",
  declined: "#c33",
};

/** The label for a card's item line: `TYPE` or `TYPE | name` for named types. */
function itemLabel(req: MaterialRequest): string {
  return req.item_name ? `${req.item_type} | ${req.item_name}` : req.item_type;
}

export function RequestsScreen(): React.ReactNode {
  const db = useDb();
  const [rows, setRows] = useState<MaterialRequest[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setRows(await listRequests(db));
  }, [db]);

  useEffect(() => {
    void load();
    return subscribeRequestsChanged(() => void load());
  }, [load]);

  const selected = rows.find((r) => r.id === selectedId) ?? null;

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.list}>
        {rows.length === 0 ? (
          <Text style={styles.hint}>No requests.</Text>
        ) : (
          rows.map((r, i) => {
            const prev = rows[i - 1];
            const grouped = prev != null && prev.order_ref !== "" && prev.order_ref === r.order_ref;
            return (
              <View key={r.id}>
                {grouped ? <View style={styles.groupTie} /> : null}
                <RequestCard req={r} onOpen={() => setSelectedId(r.id)} />
              </View>
            );
          })
        )}
      </ScrollView>

      <RequestDetail
        req={selected}
        onClose={() => setSelectedId(null)}
        onMutated={() => {
          void load();
          notifyRequestsChanged();
        }}
      />
    </View>
  );
}

/** One request card in the list. */
function RequestCard({
  req,
  onOpen,
}: {
  req: MaterialRequest;
  onOpen: () => void;
}): React.ReactNode {
  const color = STATUS_COLORS[req.status] ?? "#888";
  return (
    <Pressable style={styles.card} onPress={onOpen}>
      <View style={styles.cardHead}>
        <Text style={styles.cardTitle}>{itemLabel(req)}</Text>
        <View style={[styles.chip, { backgroundColor: color }]}>
          <Text style={styles.chipText}>{req.status}</Text>
        </View>
      </View>
      <Text style={styles.meta}>
        {req.quantity} unit(s) · Bldg {req.building || "n/a"} · {req.jobsite || req.requester || "jobsite"}
      </Text>
      <Text style={styles.meta}>
        {req.requester || "—"} · {req.contact || "—"}
      </Text>
      {req.note ? <Text style={styles.note}>“{req.note}”</Text> : null}
      {req.order_ref ? <Text style={styles.orderRef}>order {req.order_ref}</Text> : null}
      {req.handler_note ? (
        <Text style={styles.handlerNote}>
          {req.handled_at ? `${req.handled_at} — ` : ""}{req.handler_note}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** Detail sheet with full fields and status-driven actions. */
function RequestDetail({
  req,
  onClose,
  onMutated,
}: {
  req: MaterialRequest | null;
  onClose: () => void;
  onMutated: () => void;
}): React.ReactNode {
  const db = useDb();
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    setDeclining(false);
    setNote("");
  }, [req?.id]);

  if (!req) return null;
  const actions = requestActions(req.status);

  const startStaging = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await setRequestStatus(db, req.id, "staging");
      onMutated();
      void syncNow();
      onClose();
      router.push({ pathname: "/check-out", params: { requestId: String(req.id) } });
    } finally {
      setBusy(false);
    }
  };

  const resumeStaging = (): void => {
    onClose();
    router.push({ pathname: "/check-out", params: { requestId: String(req.id) } });
  };

  const cancelStaging = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await setRequestStatus(db, req.id, "pending");
      onMutated();
      void syncNow();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const confirmDecline = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await setRequestStatus(db, req.id, "declined", note.trim());
      onMutated();
      void syncNow();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={req !== null} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <ScrollView contentContainerStyle={styles.sheetBody}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>{itemLabel(req)}</Text>
              <View style={[styles.chip, { backgroundColor: STATUS_COLORS[req.status] ?? "#888" }]}>
                <Text style={styles.chipText}>{req.status}</Text>
              </View>
            </View>

            <Field label="Quantity" value={`${req.quantity} unit(s)`} />
            <Field label="Destination building" value={req.building || "n/a"} />
            <Field label="Jobsite" value={req.jobsite || "n/a"} />
            <Field label="Requester" value={req.requester || "n/a"} />
            <Field label="Contact" value={req.contact || "n/a"} />
            <Field label="Note" value={req.note || "—"} />
            <Field label="Order ref" value={req.order_ref || "—"} />
            <Field label="Created" value={req.created_at || "—"} />
            {actions.resolved ? (
              <Field label="Handled" value={req.handled_at || "—"} />
            ) : null}
            {req.handler_note ? <Field label="Handler note" value={req.handler_note} /> : null}

            {declining ? (
              <View style={styles.declineBox}>
                <Text style={styles.label}>Decline note (optional)</Text>
                <TextInput
                  style={styles.input}
                  value={note}
                  onChangeText={setNote}
                  placeholder="Why is it declined?"
                  multiline
                />
                <View style={styles.actions}>
                  <Pressable style={styles.cancelBtn} onPress={() => setDeclining(false)}>
                    <Text style={styles.cancelBtnText}>Back</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.declineBtn, busy && styles.btnDisabled]}
                    disabled={busy}
                    onPress={() => void confirmDecline()}
                  >
                    <Text style={styles.primaryBtnText}>{busy ? "…" : "Confirm decline"}</Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <View style={styles.actions}>
                {actions.fulfill ? (
                  <Pressable
                    style={[styles.primaryBtn, busy && styles.btnDisabled]}
                    disabled={busy}
                    onPress={() => void startStaging()}
                  >
                    <Text style={styles.primaryBtnText}>{busy ? "…" : "Fulfill"}</Text>
                  </Pressable>
                ) : null}
                {actions.resumeStaging ? (
                  <Pressable style={styles.primaryBtn} onPress={resumeStaging}>
                    <Text style={styles.primaryBtnText}>Resume staging</Text>
                  </Pressable>
                ) : null}
                {actions.cancelStaging ? (
                  <Pressable
                    style={[styles.warnBtn, busy && styles.btnDisabled]}
                    disabled={busy}
                    onPress={() => void cancelStaging()}
                  >
                    <Text style={styles.primaryBtnText}>{busy ? "…" : "Cancel staging"}</Text>
                  </Pressable>
                ) : null}
                {actions.decline ? (
                  <Pressable style={styles.declineBtn} onPress={() => setDeclining(true)}>
                    <Text style={styles.primaryBtnText}>Decline</Text>
                  </Pressable>
                ) : null}
              </View>
            )}
          </ScrollView>
          <Pressable style={styles.closeBtn} onPress={onClose}>
            <Text style={styles.closeBtnText}>Close</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

/** A labeled read-only field in the detail sheet. */
function Field({ label, value }: { label: string; value: string }): React.ReactNode {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  list: { paddingBottom: 40, gap: 8 },
  hint: { color: "#888", fontStyle: "italic", marginTop: 12 },
  groupTie: { marginLeft: 16, borderLeftWidth: 2, borderLeftColor: "#06c", height: 8 },
  card: { borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 12, backgroundColor: "white" },
  cardHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardTitle: { fontSize: 16, fontWeight: "600", flex: 1 },
  meta: { fontSize: 12, color: "#666", marginTop: 3 },
  note: { fontSize: 12, color: "#555", marginTop: 4, fontStyle: "italic" },
  orderRef: { fontSize: 11, color: "#06c", marginTop: 4, fontWeight: "600" },
  handlerNote: { fontSize: 12, color: "#0a7", marginTop: 6, fontWeight: "600" },
  chip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, marginLeft: 8 },
  chipText: { color: "white", fontSize: 11, fontWeight: "700" },
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.4)" },
  sheet: { backgroundColor: "white", borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: "85%", paddingBottom: 16 },
  sheetBody: { padding: 16, gap: 8 },
  sheetHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  sheetTitle: { fontSize: 20, fontWeight: "bold", flex: 1 },
  field: { paddingVertical: 2 },
  fieldLabel: { fontSize: 11, fontWeight: "600", color: "#999", textTransform: "uppercase" },
  fieldValue: { fontSize: 15, color: "#222" },
  declineBox: { marginTop: 8 },
  label: { fontSize: 13, fontWeight: "600", marginBottom: 4, color: "#333" },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 6, padding: 10, fontSize: 14, minHeight: 60 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  primaryBtn: { flex: 1, minWidth: 120, backgroundColor: "#0a7", padding: 14, borderRadius: 8, alignItems: "center" },
  warnBtn: { flex: 1, minWidth: 120, backgroundColor: "#e6a700", padding: 14, borderRadius: 8, alignItems: "center" },
  declineBtn: { flex: 1, minWidth: 120, backgroundColor: "#c33", padding: 14, borderRadius: 8, alignItems: "center" },
  cancelBtn: { flex: 1, minWidth: 120, backgroundColor: "#eee", padding: 14, borderRadius: 8, alignItems: "center" },
  cancelBtnText: { color: "#333", fontWeight: "600" },
  primaryBtnText: { color: "white", fontWeight: "600" },
  btnDisabled: { backgroundColor: "#9ab" },
  closeBtn: { padding: 14, alignItems: "center", borderTopWidth: 1, borderTopColor: "#eee" },
  closeBtnText: { color: "#06c", fontWeight: "600", fontSize: 16 },
});
