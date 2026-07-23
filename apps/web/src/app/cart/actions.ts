"use server";

import {
  createCartRequest,
  type CartErrResult,
  type CartLineInput,
  type CreateCartRequestResult,
} from "@rfid/domain";

import { getDb } from "@/lib/db";
import { getUser } from "@/lib/session";

/** A cart submission from the jobsite checkout form. */
export interface CartSubmission {
  requester: string;
  contact: string;
  jobsite: string;
  note: string;
  /** Legacy order-wide destination; a fallback for lines without their own. */
  deliveryBuilding: string;
  lines: CartLineInput[];
}

/**
 * Submit a whole cart as N request rows sharing an order_ref (all-or-nothing).
 * Returns the domain result so the client can render per-line `{line, message}`
 * errors against the offending lines; on success the client navigates to the
 * order-status page. The web app only inserts `requests` rows here — it never
 * mutates `tags`.
 *
 * Authenticated like an API route (`server-auth-actions`): a server action is a
 * public POST endpoint, so it must verify the principal itself — middleware
 * guards pages, but a direct `submitCart` invocation bypasses page rendering.
 * No session (and no active dev bypass) → an error result, never a write.
 */
export async function submitCart(input: CartSubmission): Promise<CreateCartRequestResult> {
  const user = await getUser();
  if (!user) {
    const err: CartErrResult = {
      ok: false,
      message: "Sign in is required to submit a request.",
      errors: [],
    };
    return err;
  }
  const db = await getDb();
  return createCartRequest(
    db,
    input.requester,
    input.contact,
    input.jobsite,
    input.note,
    input.deliveryBuilding,
    input.lines,
  );
}
