"use client";

/**
 * Client-side React Query provider, mounted once in the root layout. Wraps the
 * app in `QueryClientProvider` using the per-request / singleton
 * {@link getQueryClient}. The devtools are dynamically imported and rendered
 * only in development so the production bundle never pulls in the devtools
 * chunk (no bundle bloat — per the repo's React best-practices skill).
 */

import dynamic from "next/dynamic";
import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";

import { getQueryClient } from "@/lib/query/get-query-client";

// Lazy-load the devtools only when actually rendered (dev). `ssr: false` keeps
// them out of the server bundle; the dev-only render gate below keeps them out
// of the production client bundle.
const ReactQueryDevtools = dynamic(
  () => import("@tanstack/react-query-devtools").then((m) => m.ReactQueryDevtools),
  { ssr: false },
);

export function Providers({ children }: { children: React.ReactNode }) {
  const queryClient = getQueryClient();
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {process.env.NODE_ENV === "development" ? (
        <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />
      ) : null}
    </QueryClientProvider>
  );
}
