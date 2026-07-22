/**
 * Cross-screen request-refresh signal.
 *
 * Plans 004/006 refresh data with a plain `useEffect` on a `load` callback —
 * no React Query. Request state, though, changes on several screens (dev tools
 * inserts a row, the requests screen declines one, check-out fulfills one),
 * and the home badge + requests list must reflect those mutations without
 * waiting on focus. This tiny module-level pub/sub is the "simple event
 * emitter" the plan allows: mutation sites call {@link notifyRequestsChanged};
 * the home screen and requests list subscribe via {@link subscribeRequestsChanged}.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/** Subscribe to request mutations; returns an unsubscribe function. */
export function subscribeRequestsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Notify subscribers that request rows changed and should be reloaded. */
export function notifyRequestsChanged(): void {
  for (const listener of listeners) listener();
}
