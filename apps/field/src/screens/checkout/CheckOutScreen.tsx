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
import { Modal, Platform, ScrollView, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { KeyboardDismissible } from "@/components/KeyboardDismissible";
import { cn } from "@/lib/utils";

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
    <ScrollView
      contentContainerStyle={{ padding: 20, paddingBottom: 60, gap: 10 }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
    >
      <Text className="mb-1 text-sm italic text-muted-foreground">Pull the trigger on a box to look it up for check-out…</Text>

      {lookup ? (
        <CheckoutConfirmCard lookupResult={lookup} onCommit={(a, b) => void onCommit(a, b)} busy={busy} />
      ) : null}

      {results.length === 0 ? null : (
        <View className="mt-2 gap-2">
          {results.map((entry, i) => (
            <ResultRow key={`${entry.epc}-${i}`} entry={entry} />
          ))}
        </View>
      )}

      {__DEV__ ? (
        <Button variant="secondary" className="mt-4" onPress={() => readerService.injectScan([randomEpc()])}>
          <Text>Simulate scan</Text>
        </Button>
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
      <View className="flex-1 p-5">
        <Text className="text-sm italic text-muted-foreground">Request #{requestId} not found.</Text>
      </View>
    );
  }

  if (summary) {
    return (
      <View className="flex-1 p-5">
        <Text className="mb-2 text-[22px] font-bold text-primary">Delivered</Text>
        <Text className="mb-4 text-base text-foreground">{summary}</Text>
        <Button onPress={() => router.back()}>
          <Text>Back to requests</Text>
        </Button>
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={{ padding: 20, paddingBottom: 60, gap: 10 }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
    >
      <View className="rounded-lg border border-brand-info bg-brand-info/10 p-3">
        <Text className="text-lg font-bold text-brand-info">{itemLabel(request)}</Text>
        <Text className="mt-0.5 text-[13px] text-brand-info/80">
          Request #{request.id} · {requested} unit(s) requested · Bldg {request.building || "n/a"}
        </Text>
        <Text className="mt-0.5 text-[13px] text-brand-info/80">
          Staged: {stagedTotal} of {requested} unit(s) · {staged.length} box(es)
        </Text>
      </View>

      {error ? <Text className="font-semibold text-destructive">{error}</Text> : null}

      {lookup ? (
        <CheckoutConfirmCard
          lookupResult={lookup}
          onCommit={onStage}
          staged
          defaultBuilding={defaultBuilding}
        />
      ) : (
        <Text className="text-sm italic text-muted-foreground">Pull the trigger on a box to stage it for this request…</Text>
      )}

      {staged.length === 0 ? null : (
        <View className="mt-2 gap-1.5">
          <Text className="text-[13px] font-bold uppercase text-muted-foreground">Staged draws</Text>
          {staged.map((d, i) => (
            <View key={`${d.epc}-${i}`} className="flex-row items-center gap-2 rounded-md border border-border bg-card p-2.5">
              <View className="flex-1">
                <Text className="font-mono text-xs text-foreground">{d.epc}</Text>
                <Text className="mt-0.5 text-xs text-muted-foreground">
                  {d.amount ?? 0} unit(s) · Bldg {d.building || "n/a"}
                </Text>
              </View>
              <Button variant="destructive" size="sm" onPress={() => removeDraw(i)}>
                <Text>Remove</Text>
              </Button>
            </View>
          ))}
        </View>
      )}

      <View className="mt-3 flex-row gap-2">
        <Button
          className="flex-1"
          disabled={busy || staged.length === 0}
          variant="secondary"
          onPress={confirmDelivery}
        >
          <Text className="font-semibold">{busy ? "…" : "Confirm delivery"}</Text>
        </Button>
        <Button
          className="flex-1"
          variant="secondary"
          disabled={busy}
          onPress={() => void cancelStaging()}
        >
          <Text className="font-semibold">{busy ? "…" : "Cancel staging"}</Text>
        </Button>
      </View>

      {__DEV__ ? (
        <Button variant="secondary" className="mt-4" onPress={() => readerService.injectScan([randomEpc()])}>
          <Text>Simulate scan</Text>
        </Button>
      ) : null}

      <Modal visible={shortfall !== null} transparent animationType="slide" onRequestClose={() => setShortfall(null)}>
        <KeyboardDismissible className="flex-1 justify-end bg-black/40">
          <View className="rounded-t-2xl bg-background p-4 pb-6">
            <Text className="mb-2 text-xl font-bold text-foreground">Shortfall</Text>
            <Text className="mb-3 text-sm text-foreground">{shortfall ?? ""}</Text>
            <Input
              value={fulfillNote}
              onChangeText={setFulfillNote}
              placeholder="Note for the requester explaining the shortfall"
              multiline
              className="min-h-15"
            />
            <View className="mt-3 flex-row gap-2">
              <Button className="flex-1" variant="secondary" onPress={() => setShortfall(null)}>
                <Text>Cancel</Text>
              </Button>
              <Button
                className="flex-1"
                disabled={busy || fulfillNote.trim().length === 0}
                onPress={retryWithNote}
              >
                <Text>Confirm with note</Text>
              </Button>
            </View>
          </View>
        </KeyboardDismissible>
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
    <View className="rounded-lg border border-border bg-card p-3">
      <Text className={cn("text-[15px] font-semibold", result.ok ? "text-foreground" : "text-destructive")}>
        {message}
      </Text>
      <Text className="mt-1 text-xs text-muted-foreground">EPC: {entry.epc}</Text>
      {flag ? <Text className="mt-1.5 text-[13px] font-semibold text-destructive">⚠ {flag}</Text> : null}
    </View>
  );
}
