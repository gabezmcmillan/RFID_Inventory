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
import { Modal, Platform, Pressable, ScrollView, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

import { useDb } from "../../db/provider";
import { syncNow } from "../../sync/syncNow";
import { notifyRequestsChanged, subscribeRequestsChanged } from "./refresh";
import { requestActions } from "./requestActions";

/** Map a request status to a status-token background class. */
function statusClass(status: string): string {
  if (status === "pending") return "bg-status-partial";
  if (status === "staging") return "bg-brand-info";
  if (status === "fulfilled") return "bg-status-in";
  if (status === "declined") return "bg-destructive";
  return "bg-status-delivered";
}

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
    <View className="flex-1 p-4">
      <ScrollView contentContainerStyle={{ paddingBottom: 40, gap: 8 }}>
        {rows.length === 0 ? (
          <Text className="mt-3 text-sm italic text-muted-foreground">No requests.</Text>
        ) : (
          rows.map((r, i) => {
            const prev = rows[i - 1];
            const grouped = prev != null && prev.order_ref !== "" && prev.order_ref === r.order_ref;
            return (
              <View key={r.id}>
                {grouped ? <View className="ml-4 h-2 border-l-2 border-brand-info" /> : null}
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
  return (
    <Pressable className="rounded-xl border border-border bg-card p-3.5 active:opacity-70" onPress={onOpen}>
      <View className="flex-row items-center justify-between">
        <Text className="flex-1 text-base font-bold text-foreground">{itemLabel(req)}</Text>
        <View className={cn("ml-2 rounded-full px-2.5 py-0.5", statusClass(req.status))}>
          <Text className="text-[11px] font-bold text-white">{req.status}</Text>
        </View>
      </View>
      <Text className="mt-1 font-mono text-xs tabular-nums text-muted-foreground">
        {req.quantity} unit(s) · Bldg {req.building || "n/a"} · {req.jobsite || req.requester || "jobsite"}
      </Text>
      <Text className="mt-0.5 text-xs text-muted-foreground">
        {req.requester || "—"} · {req.contact || "—"}
      </Text>
      {req.note ? <Text className="mt-1.5 text-xs italic text-muted-foreground">“{req.note}”</Text> : null}
      {req.order_ref ? <Text className="mt-1 text-[11px] font-semibold text-brand-info">order {req.order_ref}</Text> : null}
      {req.handler_note ? (
        <Text className="mt-1.5 text-xs font-semibold text-primary">
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
      <View className="flex-1 justify-end bg-black/40">
        <View className="max-h-[85%] rounded-t-2xl bg-background pb-4">
          <ScrollView
            contentContainerStyle={{ padding: 16, gap: 8 }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          >
            <View className="mb-2 flex-row items-center justify-between">
              <Text className="flex-1 text-xl font-bold text-brand-navy">{itemLabel(req)}</Text>
              <View className={cn("ml-2 rounded-full px-2.5 py-0.5", statusClass(req.status))}>
                <Text className="text-[11px] font-bold text-white">{req.status}</Text>
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
              <View className="mt-2">
                <Text className="mb-1 text-[13px] font-semibold text-foreground">Decline note (optional)</Text>
                <Input
                  value={note}
                  onChangeText={setNote}
                  placeholder="Why is it declined?"
                  multiline
                  className="min-h-15"
                />
                <View className="mt-3 flex-row flex-wrap gap-2">
                  <Button className="min-w-30 flex-1" variant="secondary" onPress={() => setDeclining(false)}>
                    <Text>Back</Text>
                  </Button>
                  <Button
                    className="min-w-30 flex-1"
                    variant="destructive"
                    disabled={busy}
                    onPress={() => void confirmDecline()}
                  >
                    <Text>{busy ? "…" : "Confirm decline"}</Text>
                  </Button>
                </View>
              </View>
            ) : (
              <View className="mt-3 flex-row flex-wrap gap-2">
                {actions.fulfill ? (
                  <Button className="min-w-30 flex-1" disabled={busy} onPress={() => void startStaging()}>
                    <Text>{busy ? "…" : "Fulfill"}</Text>
                  </Button>
                ) : null}
                {actions.resumeStaging ? (
                  <Button className="min-w-30 flex-1" onPress={resumeStaging}>
                    <Text>Resume staging</Text>
                  </Button>
                ) : null}
                {actions.cancelStaging ? (
                  <Button
                    className="min-w-30 flex-1"
                    variant="secondary"
                    disabled={busy}
                    onPress={() => void cancelStaging()}
                  >
                    <Text>{busy ? "…" : "Cancel staging"}</Text>
                  </Button>
                ) : null}
                {actions.decline ? (
                  <Button className="min-w-30 flex-1" variant="destructive" onPress={() => setDeclining(true)}>
                    <Text>Decline</Text>
                  </Button>
                ) : null}
              </View>
            )}
          </ScrollView>
          <Pressable className="border-t border-border py-4 items-center active:opacity-70" onPress={onClose}>
            <Text className="text-base font-semibold text-brand-info">Close</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

/** A labeled read-only field in the detail sheet. */
function Field({ label, value }: { label: string; value: string }): React.ReactNode {
  return (
    <View className="py-0.5">
      <Text className="text-[11px] font-semibold uppercase text-muted-foreground/70">{label}</Text>
      <Text className="text-[15px] text-foreground">{value}</Text>
    </View>
  );
}
