import type { ReactNode } from "react";

/**
 * Consistent page header: title, optional description, and an optional action
 * slot (passed as `children`, per the composition-over-render-props rule — e.g.
 * a filter toggle or a primary action). Used across the dashboard, requests,
 * warehouse, admin devices, link-device, and tag pages so every page opens
 * with the same rhythm.
 */
export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}

/** A dashed, centered empty state with an icon-ish title + description. Keeps
 * every list page's "nothing here yet" state consistent. */
export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mt-2 rounded-xl border border-dashed border-border px-6 py-10 text-center">
      <p className="font-medium text-foreground">{title}</p>
      {description ? (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}
