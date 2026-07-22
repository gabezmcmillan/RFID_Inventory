/**
 * Material-request repository (db.py:1403-1600).
 *
 * `createRequest` is new: the web app inserts requests directly (status
 * `pending`, `created_at` now, no audit event — events are the warehouse
 * device's audit trail). `fulfillRequest` applies staged draws via the normal
 * checkout path inside one transaction.
 */

import {
  REQUEST_DECLINED,
  REQUEST_FULFILLED,
  REQUEST_PENDING,
  REQUEST_STAGING,
} from "../constants.js";
import type { SqlDatabase } from "../sql.js";
import { withTransaction } from "../sql.js";
import type {
  CreateRequestResult,
  FulfillDraw,
  FulfillRequestResult,
  MaterialRequest,
  SetRequestStatusResult,
} from "../types.js";
import { deliverUnitsInTx } from "./checkout.js";
import { logEvent } from "./events.js";
import { asQuantity, now } from "./util.js";

interface RequestRow {
  id: number;
  item_type: string;
  item_name: string;
  quantity: number;
  building: string;
  jobsite: string;
  requester: string;
  contact: string;
  note: string;
  status: string;
  created_at: string;
  handled_at: string;
  handler_note: string;
  order_ref: string;
  updated_at: string;
}

function requestDict(row: RequestRow): MaterialRequest {
  return {
    id: row.id,
    item_type: row.item_type,
    item_name: row.item_name,
    quantity: row.quantity,
    building: row.building,
    jobsite: row.jobsite,
    requester: row.requester,
    contact: row.contact,
    note: row.note,
    status: row.status,
    created_at: row.created_at,
    handled_at: row.handled_at,
    handler_note: row.handler_note,
    order_ref: row.order_ref,
    updated_at: row.updated_at,
  };
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
  db: SqlDatabase,
  input: CreateRequestInput,
): Promise<CreateRequestResult> {
  const ts = now();
  const res = await db.run(
    "INSERT INTO requests (item_type, item_name, quantity, building, jobsite, " +
      "requester, contact, note, status, created_at, handled_at, handler_note, " +
      "order_ref, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [
      input.item_type,
      (input.item_name ?? "").toString(),
      asQuantity(input.quantity),
      (input.building ?? "").toString(),
      (input.jobsite ?? "").toString(),
      (input.requester ?? "").toString(),
      (input.contact ?? "").toString(),
      (input.note ?? "").toString(),
      REQUEST_PENDING,
      ts,
      "",
      "",
      (input.order_ref ?? "").toString(),
      ts,
    ],
  );
  const row = await db.get<RequestRow>("SELECT * FROM requests WHERE id=?", [
    Number(res.lastInsertRowid),
  ]);
  return { ok: true, message: "Request created.", request: row ? requestDict(row) : undefined };
}

/** Requests, open ones (staging, then pending) first, then newest (db.py:1459-1470). */
export async function listRequests(
  db: SqlDatabase,
  status?: string | null,
): Promise<MaterialRequest[]> {
  let sql = "SELECT * FROM requests";
  const params: unknown[] = [];
  if (status) {
    sql += " WHERE status=?";
    params.push(status);
  }
  sql +=
    " ORDER BY CASE status WHEN 'staging' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, id DESC";
  const rows = await db.all<RequestRow>(sql, params);
  return rows.map(requestDict);
}

/** Open requests (pending or staging) for the mode-card badge (db.py:1472-1478). */
export async function countOpenRequests(db: SqlDatabase): Promise<number> {
  const row = await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM requests WHERE status IN (?, ?)",
    [REQUEST_PENDING, REQUEST_STAGING],
  );
  return row ? row.n : 0;
}

/** Allowed manager transitions. `fulfilled` is reachable only via fulfillRequest. */
const REQUEST_TRANSITIONS: Record<string, string[]> = {
  [REQUEST_PENDING]: [REQUEST_STAGING, REQUEST_DECLINED],
  [REQUEST_STAGING]: [REQUEST_PENDING, REQUEST_DECLINED],
};

/** Move a request between pending/staging/declined (db.py:1487-1521). */
export async function setRequestStatus(
  db: SqlDatabase,
  reqId: number,
  status: string,
  note = "",
): Promise<SetRequestStatusResult> {
  const cleanNote = (note ?? "").toString().trim();
  const ts = now();
  const row = await db.get<RequestRow>("SELECT * FROM requests WHERE id=?", [reqId]);
  if (!row) return { ok: false, message: `Request #${reqId} not found.` };

  const allowed = REQUEST_TRANSITIONS[row.status] ?? [];
  if (!allowed.includes(status)) {
    return {
      ok: false,
      message: `Request #${reqId} is ${row.status}; cannot mark it ${status}.`,
    };
  }

  await withTransaction(db, async () => {
    await db.run(
      "UPDATE requests SET status=?, handled_at=?, handler_note=?, updated_at=? WHERE id=?",
      [status, ts, cleanNote, ts, reqId],
    );
    const action =
      status === REQUEST_PENDING ? "REQUEST_PENDING" : "REQUEST_" + status.toUpperCase();
    let detail = `#${reqId}: ${row.quantity} x ${row.item_type}`;
    if (cleanNote) detail += ` -- ${cleanNote}`;
    await logEvent(db, action, "", row.item_type, "", row.building, "", detail);
  });

  const updated = await db.get<RequestRow>("SELECT * FROM requests WHERE id=?", [reqId]);
  return {
    ok: true,
    message: `Request #${reqId} ${status}.`,
    request: updated ? requestDict(updated) : undefined,
  };
}

/**
 * Commit staged checkout draws and mark the request fulfilled, in one
 * transaction (db.py:1523-1600). Short delivery without a note rolls back.
 */
export async function fulfillRequest(
  db: SqlDatabase,
  reqId: number,
  draws: FulfillDraw[],
  note = "",
): Promise<FulfillRequestResult> {
  const cleanNote = (note ?? "").toString().trim();
  const ts = now();

  return withTransaction(db, async () => {
    const row = await db.get<RequestRow>("SELECT * FROM requests WHERE id=?", [reqId]);
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
    await db.run(
      "UPDATE requests SET status=?, handled_at=?, handler_note=?, updated_at=? WHERE id=?",
      [REQUEST_FULFILLED, ts, handlerNote, ts, reqId],
    );
    const boxes = results.filter((r) => r.ok).length;
    let label = row.item_type;
    if (row.item_name) label += ` | ${row.item_name}`;
    let detail = `#${reqId}: ${deliveredTotal} of ${requested} x ${label} from ${boxes} box(es)`;
    if (cleanNote) detail += ` -- ${cleanNote}`;
    await logEvent(db, REQUEST_FULFILLED, "", row.item_type, "", row.building, "", detail);

    const updated = await db.get<RequestRow>("SELECT * FROM requests WHERE id=?", [reqId]);
    return {
      ok: true,
      message: `Request #${reqId} fulfilled: ${deliveredTotal} of ${requested} unit(s) delivered.`,
      delivered: deliveredTotal,
      requested,
      short,
      results,
      request: updated ? requestDict(updated) : undefined,
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
