/**
 * Status → Badge styling helpers. One place maps the domain's status strings to
 * the shadcn `Badge` look, using the shared status palette tokens
 * (`--status-in` / `--status-partial` / `--status-delivered`, plus
 * `--destructive` and `--brand`) so chips are consistent across pages.
 *
 * In = green, Partial = amber, Delivered = gray — the standing convention. The
 * label text matches the prior hand-rolled chips exactly (a restyle, not a
 * rewrite), so no user-visible strings change.
 */

export interface BadgeStyle {
  /** The human-readable label (unchanged from the prior chips). */
  label: string;
  /** Tailwind classes layered on a `Badge variant="outline"`: border + text + a
   * faint tinted background, all driven by the status CSS-var tokens. */
  className: string;
}

const base = "border bg-transparent";

/** A request line's status (pending/staging/fulfilled/declined) → chip style. */
export function requestStatusBadge(status: string): BadgeStyle {
  switch (status) {
    case "pending":
      return { label: "Pending", className: `${base} border-brand/40 text-brand bg-brand/10` };
    case "staging":
      return { label: "Staging", className: `${base} border-status-partial/40 text-status-partial bg-status-partial/10` };
    case "fulfilled":
      return { label: "Fulfilled", className: `${base} border-status-in/40 text-status-in bg-status-in/10` };
    case "declined":
      return { label: "Declined", className: `${base} border-destructive/40 text-destructive bg-destructive/10` };
    default:
      return { label: status, className: `${base} border-border text-muted-foreground` };
  }
}

/** An order's open/closed state → chip style. */
export function orderStateBadge(open: boolean): BadgeStyle {
  return open
    ? { label: "Open", className: `${base} border-brand/40 text-brand bg-brand/10` }
    : { label: "Closed", className: `${base} border-border text-muted-foreground` };
}

/** An inventory group's status (In Warehouse/Partial/Delivered) → chip style. */
export function inventoryStatusBadge(status: string): BadgeStyle {
  switch (status) {
    case "In Warehouse":
      return { label: status, className: `${base} border-status-in/40 text-status-in bg-status-in/10` };
    case "Partial":
      return { label: status, className: `${base} border-status-partial/40 text-status-partial bg-status-partial/10` };
    case "Delivered":
      return { label: status, className: `${base} border-status-delivered/40 text-status-delivered bg-status-delivered/10` };
    default:
      return { label: status, className: `${base} border-border text-muted-foreground` };
  }
}
