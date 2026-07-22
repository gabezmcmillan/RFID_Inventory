/**
 * The single place that derives the UI actions available for a request from its
 * status. Components render buttons off these booleans — no request-status
 * strings are hard-coded in views (plan 008 maintenance note). The transition
 * table itself lives in `packages/domain`; this only mirrors which actions the
 * *detail sheet* exposes per status.
 *
 * - `pending`   → Fulfill / Decline
 * - `staging`   → Resume staging / Cancel staging / Decline
 * - `fulfilled` / `declined` → read-only (`resolved`)
 */

import {
  REQUEST_DECLINED,
  REQUEST_FULFILLED,
  REQUEST_PENDING,
  REQUEST_STAGING,
} from "@rfid/domain";

/** The actions the request detail sheet may expose. */
export interface RequestActions {
  /** `pending` → start staging (sets status `staging`, opens Check Out). */
  readonly fulfill: boolean;
  /** `pending` / `staging` → turn the request down with a note. */
  readonly decline: boolean;
  /** `staging` → re-enter Check Out staging mode (empty staged list). */
  readonly resumeStaging: boolean;
  /** `staging` → return to `pending`, discarding staged draws. */
  readonly cancelStaging: boolean;
  /** `fulfilled` / `declined` → no actions, read-only with handler_note. */
  readonly resolved: boolean;
}

/** Derive the available detail-sheet actions from a request's status. */
export function requestActions(status: string): RequestActions {
  switch (status) {
    case REQUEST_PENDING:
      return {
        fulfill: true,
        decline: true,
        resumeStaging: false,
        cancelStaging: false,
        resolved: false,
      };
    case REQUEST_STAGING:
      return {
        fulfill: false,
        decline: true,
        resumeStaging: true,
        cancelStaging: true,
        resolved: false,
      };
    case REQUEST_FULFILLED:
    case REQUEST_DECLINED:
      return {
        fulfill: false,
        decline: false,
        resumeStaging: false,
        cancelStaging: false,
        resolved: true,
      };
    default:
      return {
        fulfill: false,
        decline: false,
        resumeStaging: false,
        cancelStaging: false,
        resolved: true,
      };
  }
}
