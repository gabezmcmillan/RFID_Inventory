/**
 * Material-request repository (db.py:1403-1600).
 *
 * `createRequest` is new: the web app inserts requests directly (status
 * `pending`, `created_at` now, no audit event — events are the warehouse
 * device's audit trail). `fulfillRequest` applies staged draws via the normal
 * checkout path inside one transaction.
 */

import { desc, eq, inArray, sql } from "drizzle-orm";

import {
  REQUEST_DECLINED,
  REQUEST_FULFILLED,
  REQUEST_PENDING,
  REQUEST_STAGING,
} from "../constants";
import type { DomainDb } from "../db";
import { withTransaction } from "../db";
import { requests } from "../schema";
import type {
  CreateRequestResult,
  FulfillDraw,
  FulfillRequestResult,
  MaterialRequest,
  SetRequestStatusResult,
} from "../types";
import { deliverUnitsInTx } from "./checkout";
import { logEvent } from "./events";
import { asQuantity, now } from "./util";

/** Raw `requests` row shape (inferred from the Drizzle schema). */
type RequestRow = typeof requests.$inferSelect;

function requestDict(row: RequestRow): MaterialRequest {
  return { ...row };
}

export interface CreateRequestInput {
  item_type: string;
  item_name?: string;
  quantity?: unknown;
  building?: string;
  jobsite?: string;
  requester?: string;
  contact?: string;
  note?: string;
  order_ref?: string;
}

/** Direct insert used by the web app. Status `pending`, `created_at` now, no event. */
export async function createRequest(
  db: DomainDb,
  input: CreateRequestInput,
): Promise<CreateRequestResult> {
  const ts = now();
  const inserted = await db
    .insert(requests)
    .values({
      item_type: input.item_type,
      item_name: (input.item_name ?? "").toString(),
      quantity: asQuantity(input.quantity),
      building: (input.building ?? "").toString(),
      jobsite: (input.jobsite ?? "").toString(),
      requester: (input.requester ?? "").toString(),
      contact: (input.contact ?? "").toString(),
      note: (input.note ?? "").toString(),
      status: REQUEST_PENDING,
      created_at: ts,
      handled_at: "",
      handler_note: "",
      order_ref: (input.order_ref ?? "").toString(),
      updated_at: ts,
    })
    .returning();
  return { ok: true, message: "Request created.", request: inserted[0] ? requestDict(inserted[0]) : undefined };
}

/** Requests, open ones (staging, then pending) first, then newest (db.py:1459-1470). */
export async function listRequests(
  db: DomainDb,
  status?: string | null,
): Promise<MaterialRequest[]> {
  const rows = await db
    .select()
    .from(requests)
    .where(status ? eq(requests.status, status) : undefined)
    .orderBy(
      sql`CASE ${requests.status} WHEN 'staging' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END`,
      desc(requests.id),
    );
  return rows.map(requestDict);
}

/** Open requests (pending or staging) for the mode-card badge (db.py:1472-1478). */
export async function countOpenRequests(db: DomainDb): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(requests)
    .where(inArray(requests.status, [REQUEST_PENDING, REQUEST_STAGING]));
  return rows[0]?.n ?? 0;
}

/** Allowed manager transitions. `fulfilled` is reachable only via fulfillRequest. */
const REQUEST_TRANSITIONS: Record<string, string[]> = {
  [REQUEST_PENDING]: [REQUEST_STAGING, REQUEST_DECLINED],
  [REQUEST_STAGING]: [REQUEST_PENDING, REQUEST_DECLINED],
};

/** Move a request between pending/staging/declined (db.py:1487-1521). */
export async function setRequestStatus(
  db: DomainDb,
  reqId: number,
  status: string,
  note = "",
): Promise<SetRequestStatusResult> {
  const cleanNote = (note ?? "").toString().trim();
  const ts = now();
  const rows = await db.select().from(requests).where(eq(requests.id, reqId));
  const row = rows[0];
  if (!row) return { ok: false, message: `Request #${reqId} not found.` };

  const allowed = REQUEST_TRANSITIONS[row.status] ?? [];
  if (!allowed.includes(status)) {
    return {
      ok: false,
      message: `Request #${reqId} is ${row.status}; cannot mark it ${status}.`,
    };
  }

  await withTransaction(db, async () => {
    await db
      .update(requests)
      .set({ status, handled_at: ts, handler_note: cleanNote, updated_at: ts })
      .where(eq(requests.id, reqId));
    const action =
      status === REQUEST_PENDING ? "REQUEST_PENDING" : "REQUEST_" + status.toUpperCase();
    let detail = `#${reqId}: ${row.quantity} x ${row.item_type}`;
    if (cleanNote) detail += ` -- ${cleanNote}`;
    await logEvent(db, action, "", row.item_type, "", row.building, "", detail);
  });

  const updated = await db.select().from(requests).where(eq(requests.id, reqId));
  return {
    ok: true,
    message: `Request #${reqId} ${status}.`,
    request: updated[0] ? requestDict(updated[0]) : undefined,
  };
}

/**
 * Commit staged checkout draws and mark the request fulfilled, in one
 * transaction (db.py:1523-1600). Short delivery without a note rolls back.
 */
export async function fulfillRequest(
  db: DomainDb,
  reqId: number,
  draws: FulfillDraw[],
  note = "",
): Promise<FulfillRequestResult> {
  const cleanNote = (note ?? "").toString().trim();
  const ts = now();

  return withTransaction(db, async () => {
    const rows = await db.select().from(requests).where(eq(requests.id, reqId));
    const row = rows[0];
    if (!row) {
      return { ok: false, message: `Request #${reqId} not found.`, results: [] } satisfies FulfillRequestResult;
    }
    if (row.status !== REQUEST_PENDING && row.status !== REQUEST_STAGING) {
      return {
        ok: false,
        message: `Request #${reqId} is already ${row.status}.`,
        results: [],
      } satisfies FulfillRequestResult;
    }

    const results: FulfillRequestResult["results"] = [];
    let deliveredTotal = 0;
    for (const d of draws ?? []) {
      const epc = (d.epc ?? "").toString().trim();
      if (!epc) continue;
      const result = await deliverUnitsInTx(db, epc, d.amount ?? null, d.building ?? "");
      results.push(result);
      if (result.ok) deliveredTotal += result.delivered ?? 0;
    }

    const requested = row.quantity;
    const short = deliveredTotal < requested;

    if (deliveredTotal <= 0) {
      throw new NothingDeliveredError(results);
    }
    if (short && !cleanNote) {
      throw new NoteRequiredError(deliveredTotal, requested);
    }

    let handlerNote = cleanNote;
    if (short) {
      handlerNote = `${deliveredTotal} of ${requested} supplied` + (cleanNote ? ` -- ${cleanNote}` : "");
    }
    await db
      .update(requests)
      .set({ status: REQUEST_FULFILLED, handled_at: ts, handler_note: handlerNote, updated_at: ts })
      .where(eq(requests.id, reqId));
    const boxes = results.filter((r) => r.ok).length;
    let label = row.item_type;
    if (row.item_name) label += ` | ${row.item_name}`;
    let detail = `#${reqId}: ${deliveredTotal} of ${requested} x ${label} from ${boxes} box(es)`;
    if (cleanNote) detail += ` -- ${cleanNote}`;
    await logEvent(db, REQUEST_FULFILLED, "", row.item_type, "", row.building, "", detail);

    const updated = await db.select().from(requests).where(eq(requests.id, reqId));
    return {
      ok: true,
      message: `Request #${reqId} fulfilled: ${deliveredTotal} of ${requested} unit(s) delivered.`,
      delivered: deliveredTotal,
      requested,
      short,
      results,
      request: updated[0] ? requestDict(updated[0]) : undefined,
    } satisfies FulfillRequestResult;
  }).catch((err) => {
    if (err instanceof NothingDeliveredError) {
      const failed = err.results.map((r) => r.message ?? "").join("; ");
      return {
        ok: false,
        message: "Nothing was delivered" + (failed ? `: ${failed}` : ": no boxes staged."),
        results: err.results,
      } satisfies FulfillRequestResult;
    }
    if (err instanceof NoteRequiredError) {
      return {
        ok: false,
        note_required: true,
        message:
          `Only ${err.deliveredTotal} of ${err.requested} unit(s) supplied -- add a note for the requester explaining the shortfall.`,
        results: [],
      } satisfies FulfillRequestResult;
    }
    throw err;
  });
}

class NothingDeliveredError extends Error {
  results: FulfillRequestResult["results"];
  constructor(results: FulfillRequestResult["results"]) {
    super("nothing delivered");
    this.results = results;
  }
}

class NoteRequiredError extends Error {
  deliveredTotal: number;
  requested: number;
  constructor(deliveredTotal: number, requested: number) {
    super("note required");
    this.deliveredTotal = deliveredTotal;
    this.requested = requested;
  }
}
