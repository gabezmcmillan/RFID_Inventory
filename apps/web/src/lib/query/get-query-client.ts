/**
 * Per-request / singleton `QueryClient` factory — the canonical TanStack Query v5
 * + Next.js App Router setup (see the "Advanced Server Rendering" guide).
 *
 * - **Server**: `getQueryClient()` returns a fresh `QueryClient` on every call.
 *   A Server Component prefetches into it, then `dehydrate()`s it into a
 *   `<HydrationBoundary>`. One client per prefetch site avoids the duplicated-
 *   serialization overhead of a `cache()`-shared client (the guide's primary
 *   recommendation).
 * - **Browser**: a single memoized `QueryClient` is reused across renders so
 *   React suspending during the initial render doesn't throw the client away.
 *
 * `staleTime: 60s` so hydrated data isn't refetched the instant it reaches the
 * client. The `dehydrate` config includes pending queries (streaming-ready)
 * and does NOT redact errors (so Next.js can still detect dynamic pages via
 * thrown errors — see the guide's `shouldRedactErrors` note).
 *
 * All env reads go through `@/lib/env`; this module pulls nothing from the DB,
 * so importing it on the client (in `Providers`) is safe and bundle-light.
 */

import {
  defaultShouldDehydrateQuery,
  environmentManager,
  QueryClient,
} from "@tanstack/react-query";

/** Build a `QueryClient` with the app's default query + dehydrate options. */
function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // With SSR, set a non-zero staleTime so the client doesn't refetch
        // hydrated data immediately on mount.
        staleTime: 60 * 1000,
      },
      dehydrate: {
        // Include pending queries so streaming works (v5.40+): a prefetch kicked
        // off on the server can finish on the client.
        shouldDehydrateQuery: (query) =>
          defaultShouldDehydrateQuery(query) || query.state.status === "pending",
        // Do not redact errors — Next.js detects dynamic pages via thrown errors
        // and already redacts with better digests.
        shouldRedactErrors: () => false,
      },
    },
  });
}

// Browser-only singleton. `undefined` on the server (the server branch never
// touches this module-level slot — `environmentManager.isServer()` is true).
let browserQueryClient: QueryClient | undefined;

/**
 * Get the `QueryClient` for the current context: a fresh one on the server
 * (one per prefetch site), the memoized singleton in the browser.
 */
export function getQueryClient(): QueryClient {
  if (environmentManager.isServer()) {
    return makeQueryClient();
  }
  if (!browserQueryClient) {
    browserQueryClient = makeQueryClient();
  }
  return browserQueryClient;
}
