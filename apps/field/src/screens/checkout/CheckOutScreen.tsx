/**
 * Check Out screen — the two-step drawdown (db.py:744-857, app.py:196-203),
 * and plan 008's request-staging mode (db.py:1523-1600, app.py:527-542).
 *
 * Normal mode: a trigger pull only looks the box up (`lookupForCheckout`); the
 * {@link CheckoutConfirmCard} then collects an amount + destination and the
 * screen commits via `deliverUnits`, appending a result row.
 *
 * Staging mode (`/check-out?requestId=N`): the request is already `staging`.
 * A banner shows the request summary and a running staged total vs the
 * requested quantity; each scanned box's confirm card (staged variant) appends
 * a draw `{epc, amount, building}` to a local staged list — **no `deliverUnits`
 * call**. "Confirm delivery" calls `fulfillRequest(id, draws, note)`; on
 * `note_required` the shortfall dialog collects a note and retries; on success
 * the summary is shown and we pop back to the requests list. "Cancel staging"
 * returns the request to `pending`, discards draws, and pops. Leaving without
 * confirming keeps the request `staging` (matching the PC app); "Resume
 * staging" re-enters with an empty staged list. Reader runs `checkout` while
 * focused and returns to `idle` on blur.
 */

import {
  deliverUnits,
  fulfillRequest,
  lookupForCheckout,
  listRequests,
  setRequestStatus,
  type DeliverUnitsResult,
  type FulfillDraw,
  type LookupForCheckoutResult,
  type MaterialRequest,
} from "@rfid/domain";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { useDb } from "../../db/provider";
import { useReaderEvents } from "../../hooks/useReaderEvents";
import { readerService } from "../../reader/readerService";
import { syncNow } from "../../sync/syncNow";
import { notifyRequestsChanged } from "../requests/refresh";
import { CheckoutConfirmCard } from "./CheckoutConfirmCard";

/** One entry in the checkout result log: a commit result or a lookup error. */
interface CheckoutResultEntry {
  readonly epc: string;
  readonly result: DeliverUnitsResult | { readonly ok: false; readonly message: string };
}

/** A 24-hex EPC for the dev "simulate scan" button. */
function randomEpc(): string {
  const hex = "0123456789ABCDEF";
  let s = "";
  for (let i = 0; i < 24; i++) s += hex[Math.floor(Math.random() * 16)];
  return s;
}

/** The label for a request's item line: `TYPE` or `TYPE | name` for named types. */
function itemLabel(req: MaterialRequest): string {
  return req.item_name ? `${req.item_type} | ${req.item_name}` : req.item_type;
}

export function CheckOutScreen(): React.ReactNode {
  const db = useDb();
  const params = useLocalSearchParams<{ requestId?: string }>();
  const requestId = params.requestId ? Number(params.requestId) : NaN;
  const staging = !Number.isNaN(requestId);

  const [request, setRequest] = useState<MaterialRequest | null>(null);
  const [lookup, setLookup] = useState<LookupForCheckoutResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<CheckoutResultEntry[]>([]);
  const [staged, setStaged] = useState<FulfillDraw[]>([]);

  if (staging) {
    return (
      <StagingCheckOut
        db={db}
        requestId={requestId}
        request={request}
        setRequest={setRequest}
        lookup={lookup}
        setLookup={setLookup}
        busy={busy}
        setBusy={setBusy}
        staged={staged}
        setStaged={setStaged}
      />
    );
  }
  return (
    <NormalCheckOut
      db={db}
      lookup={lookup}
      setLookup={setLookup}
      busy={busy}
      setBusy={setBusy}
      results={results}
      setResults={setResults}
    />
  );
}

/** The standalone (non-staging) check-out flow. */
interface NormalCheckOutProps {
  readonly db: ReturnType<typeof useDb>;
  readonly lookup: LookupForCheckoutResult | null;
  readonly setLookup: (l: LookupForCheckoutResult | null) => void;
  readonly busy: boolean;
  readonly setBusy: (b: boolean) => void;
  readonly results: CheckoutResultEntry[];
  readonly setResults: (r: CheckoutResultEntry[] | ((p: CheckoutResultEntry[]) => CheckoutResultEntry[])) => void;
}

function NormalCheckOut({
  db,
  lookup,
  setLookup,
  busy,
  setBusy,
  results,
  setResults,
}: NormalCheckOutProps): React.ReactNode {
  // Scan handler: look the box up. ok → show the confirm card; !ok → error row.
  useReaderEvents((event) => {
    if (event.event !== "scan" || event.mode !== "checkout") return;
    void (async () => {
      const result = await lookupForCheckout(db, event.epc);
      if (result.ok) {
        setLookup(result);
      } else {
        setLookup(null);
        setResults((prev) => [
          ...prev,
          { epc: event.epc, result: { ok: false, message: result.message ?? `${event.epc} not registered.` } },
        ]);
      }
    })();
  });

  // Arm `checkout` on focus; return the reader to `idle` on blur (app.py:944-947).
  useEffect(() => {
    readerService.setMode("checkout");
    return () => {
      readerService.setMode("idle");
    };
  }, []);

  const onCommit = async (amount: number, building: string): Promise<void> => {
    if (!lookup || busy) return;
    setBusy(true);
    try {
      const result = await deliverUnits(db, lookup.epc, amount, building || null);
      setResults((prev) => [...prev, { epc: lookup.epc, result }]);
      setLookup(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.hint}>Pull the trigger on a box to look it up for check-out…</Text>

      {lookup ? (
        <CheckoutConfirmCard lookupResult={lookup} onCommit={(a, b) => void onCommit(a, b)} busy={busy} />
      ) : null}

      {results.length === 0 ? null : (
        <View style={styles.results}>
          {results.map((entry, i) => (
            <ResultRow key={`${entry.epc}-${i}`} entry={entry} />
          ))}
        </View>
      )}

      {__DEV__ ? (
        <Pressable style={styles.simBtn} onPress={() => readerService.injectScan([randomEpc()])}>
          <Text style={styles.simBtnText}>Simulate scan</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

/** Props shared into the staging flow (lifted from the top-level component). */
interface StagingCheckOutProps {
  readonly db: ReturnType<typeof useDb>;
  readonly requestId: number;
  readonly request: MaterialRequest | null;
  readonly setRequest: (r: MaterialRequest | null) => void;
  readonly lookup: LookupForCheckoutResult | null;
  readonly setLookup: (l: LookupForCheckoutResult | null) => void;
  readonly busy: boolean;
  readonly setBusy: (b: boolean) => void;
  readonly staged: FulfillDraw[];
  readonly setStaged: (d: FulfillDraw[] | ((p: FulfillDraw[]) => FulfillDraw[])) => void;
}

/**
 * Staging flow for a request: scan boxes into a local staged-draws list (no
 * `deliverUnits`), then "Confirm delivery" → `fulfillRequest`, or "Cancel
 * staging" → back to `pending`.
 */
function StagingCheckOut({
  db,
  requestId,
  request,
  setRequest,
  lookup,
  setLookup,
  busy,
  setBusy,
  staged,
  setStaged,
}: StagingCheckOutProps): React.ReactNode {
  const [shortfall, setShortfall] = useState<string | null>(null);
  const [fulfillNote, setFulfillNote] = useState("");
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load the request once (resume-staging re-enters with an EMPTY staged list).
  useEffect(() => {
    void (async () => {
      const rows = await listRequests(db);
      setRequest(rows.find((r) => r.id === requestId) ?? null);
    })();
  }, [db, requestId, setRequest]);

  // Scan handler: look the box up for staging.
  useReaderEvents((event) => {
    if (event.event !== "scan" || event.mode !== "checkout") return;
    void (async () => {
      const result = await lookupForCheckout(db, event.epc);
      setLookup(result.ok ? result : null);
      if (!result.ok) setError(result.message ?? `${event.epc} not registered.`);
    });
  });

  // Arm `checkout` on focus; return the reader to `idle` on blur.
  useEffect(() => {
    readerService.setMode("checkout");
    return () => {
      readerService.setMode("idle");
    };
  }, []);

  const defaultBuilding = request?.building ?? "";
  const requested = request?.quantity ?? 0;
  const stagedTotal = staged.reduce((sum, d) => sum + (d.amount ?? 0), 0);

  const onStage = (amount: number, building: string): void => {
    if (!lookup || !lookup.ok) return;
    setStaged((prev) => [...prev, { epc: lookup.epc, amount, building: building || defaultBuilding }]);
    setLookup(null);
  };

  const removeDraw = (index: number): void => {
    setStaged((prev) => prev.filter((_, i) => i !== index));
  };

  const runFulfill = async (note: string): Promise<void> => {
    if (!request || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await fulfillRequest(db, request.id, staged, note);
      if (result.ok) {
        notifyRequestsChanged();
        void syncNow();
        setSummary(result.message);
        setShortfall(null);
        return;
      }
      if (result.note_required) {
        setShortfall(result.message);
        return;
      }
      setError(result.message);
    } finally {
      setBusy(false);
    }
  };

  const confirmDelivery = (): void => {
    void runFulfill("");
  };

  const retryWithNote = (): void => {
    void runFulfill(fulfillNote);
  };

  const cancelStaging = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await setRequestStatus(db, requestId, "pending");
      notifyRequestsChanged();
      void syncNow();
      router.back();
    } finally {
      setBusy(false);
    }
  };

  if (!request) {
    return (
      <View style={styles.container}>
        <Text style={styles.hint}>Request #{requestId} not found.</Text>
      </View>
    );
  }

  if (summary) {
    return (
      <View style={styles.container}>
        <Text style={styles.summaryTitle}>Delivered</Text>
        <Text style={styles.summaryText}>{summary}</Text>
        <Pressable style={styles.primaryBtn} onPress={() => router.back()}>
          <Text style={styles.primaryBtnText}>Back to requests</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.banner}>
        <Text style={styles.bannerTitle}>{itemLabel(request)}</Text>
        <Text style={styles.bannerMeta}>
          Request #{request.id} · {requested} unit(s) requested · Bldg {request.building || "n/a"}
        </Text>
        <Text style={styles.bannerMeta}>
          Staged: {stagedTotal} of {requested} unit(s) · {staged.length} box(es)
        </Text>
      </View>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      {lookup ? (
        <CheckoutConfirmCard
          lookupResult={lookup}
          onCommit={onStage}
          staged
          defaultBuilding={defaultBuilding}
        />
      ) : (
        <Text style={styles.hint}>Pull the trigger on a box to stage it for this request…</Text>
      )}

      {staged.length === 0 ? null : (
        <View style={styles.stagedList}>
          <Text style={styles.sectionLabel}>Staged draws</Text>
          {staged.map((d, i) => (
            <View key={`${d.epc}-${i}`} style={styles.stagedRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.stagedEpc}>{d.epc}</Text>
                <Text style={styles.stagedMeta}>
                  {d.amount ?? 0} unit(s) · Bldg {d.building || "n/a"}
                </Text>
              </View>
              <Pressable style={styles.removeBtn} onPress={() => removeDraw(i)}>
                <Text style={styles.removeBtnText}>Remove</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}

      <View style={styles.actions}>
        <Pressable
          style={[styles.warnBtn, (busy || staged.length === 0) && styles.btnDisabled]}
          disabled={busy || staged.length === 0}
          onPress={confirmDelivery}
        >
          <Text style={styles.primaryBtnText}>{busy ? "…" : "Confirm delivery"}</Text>
        </Pressable>
        <Pressable
          style={[styles.cancelBtn, busy && styles.btnDisabled]}
          disabled={busy}
          onPress={() => void cancelStaging()}
        >
          <Text style={styles.cancelBtnText}>{busy ? "…" : "Cancel staging"}</Text>
        </Pressable>
      </View>

      {__DEV__ ? (
        <Pressable style={styles.simBtn} onPress={() => readerService.injectScan([randomEpc()])}>
          <Text style={styles.simBtnText}>Simulate scan</Text>
        </Pressable>
      ) : null}

      <Modal visible={shortfall !== null} transparent animationType="slide" onRequestClose={() => setShortfall(null)}>
        <View style={styles.backdrop}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Shortfall</Text>
            <Text style={styles.shortfallMsg}>{shortfall ?? ""}</Text>
            <TextInput
              style={styles.input}
              value={fulfillNote}
              onChangeText={setFulfillNote}
              placeholder="Note for the requester explaining the shortfall"
              multiline
            />
            <View style={styles.actions}>
              <Pressable style={styles.cancelBtn} onPress={() => setShortfall(null)}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.primaryBtn, (busy || fulfillNote.trim().length === 0) && styles.btnDisabled]}
                disabled={busy || fulfillNote.trim().length === 0}
                onPress={retryWithNote}
              >
                <Text style={styles.primaryBtnText}>Confirm with note</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

/** One checkout result row: the message, EPC, and a red mismatch banner. */
function ResultRow({ entry }: { entry: CheckoutResultEntry }): React.ReactNode {
  const { result } = entry;
  const message = result.message;
  const flag = "flag" in result && result.flag ? result.flag : null;
  return (
    <View style={styles.card}>
      <Text style={[styles.message, !result.ok && styles.messageError]}>{message}</Text>
      <Text style={styles.meta}>EPC: {entry.epc}</Text>
      {flag ? <Text style={styles.flagBanner}>⚠ {flag}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingBottom: 60, gap: 10 },
  hint: { color: "#888", fontStyle: "italic", marginBottom: 4 },
  banner: { borderWidth: 1, borderColor: "#06c", borderRadius: 8, padding: 12, backgroundColor: "#eef5ff" },
  bannerTitle: { fontSize: 18, fontWeight: "bold", color: "#06c" },
  bannerMeta: { fontSize: 13, color: "#336", marginTop: 3 },
  results: { marginTop: 8, gap: 8 },
  stagedList: { marginTop: 8, gap: 6 },
  sectionLabel: { fontSize: 13, fontWeight: "700", color: "#555", textTransform: "uppercase" },
  stagedRow: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: "#eee", borderRadius: 6, padding: 10, backgroundColor: "white", gap: 8 },
  stagedEpc: { fontFamily: "monospace", fontSize: 12, color: "#222" },
  stagedMeta: { fontSize: 12, color: "#666", marginTop: 2 },
  removeBtn: { paddingHorizontal: 10, paddingVertical: 6, backgroundColor: "#c33", borderRadius: 6 },
  removeBtnText: { color: "white", fontWeight: "600", fontSize: 12 },
  actions: { flexDirection: "row", gap: 8, marginTop: 12 },
  primaryBtn: { flex: 1, backgroundColor: "#0a7", padding: 14, borderRadius: 8, alignItems: "center" },
  warnBtn: { flex: 1, backgroundColor: "#06c", padding: 14, borderRadius: 8, alignItems: "center" },
  cancelBtn: { flex: 1, backgroundColor: "#eee", padding: 14, borderRadius: 8, alignItems: "center" },
  cancelBtnText: { color: "#333", fontWeight: "600" },
  primaryBtnText: { color: "white", fontWeight: "600" },
  btnDisabled: { backgroundColor: "#9ab" },
  summaryTitle: { fontSize: 22, fontWeight: "bold", color: "#0a7", marginBottom: 8 },
  summaryText: { fontSize: 16, color: "#222", marginBottom: 16 },
  errorText: { color: "#c33", fontWeight: "600" },
  card: { borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 12, backgroundColor: "white" },
  message: { fontSize: 15, fontWeight: "600", color: "#222" },
  messageError: { color: "#c33" },
  meta: { fontSize: 12, color: "#666", marginTop: 4 },
  flagBanner: { marginTop: 6, color: "#c33", fontWeight: "600", fontSize: 13 },
  simBtn: { backgroundColor: "#eee", padding: 12, borderRadius: 8, alignItems: "center", marginTop: 16 },
  simBtnText: { color: "#333", fontWeight: "600" },
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.4)" },
  sheet: { backgroundColor: "white", borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, paddingBottom: 24 },
  sheetTitle: { fontSize: 20, fontWeight: "bold", marginBottom: 8 },
  shortfallMsg: { fontSize: 14, color: "#333", marginBottom: 12 },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 6, padding: 10, fontSize: 14, minHeight: 60 },
});
