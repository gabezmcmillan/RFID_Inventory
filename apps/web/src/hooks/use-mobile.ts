import * as React from "react"

const MOBILE_BREAKPOINT = 768

// `useSyncExternalStore` is the idiomatic, SSR-safe way to subscribe to a
// browser media query: no setState-in-effect (avoids the cascading-render lint
// the prior matchMedia + useState-in-effect triggered), and the server snapshot
// is `false` so the first client render matches SSR.

function subscribe(callback: () => void): () => void {
  const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
  mql.addEventListener("change", callback)
  return () => mql.removeEventListener("change", callback)
}

function getSnapshot(): boolean {
  return window.innerWidth < MOBILE_BREAKPOINT
}

function getServerSnapshot(): boolean {
  return false
}

export function useIsMobile(): boolean {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
