/**
 * `useReaderEvents` — subscribes a screen to the {@link readerService} event
 * stream and surfaces the pieces the UI needs: the rolling event log (capped),
 * the latest check-in/check-out scan, and the connection status. Re-subscribes
 * only on mount; the singleton service owns the underlying subscription.
 */

import { useEffect, useRef, useState } from "react";

import type { ReaderEvent, ScanEvent, StatusEvent } from "@rfid/reader-protocol";

import { readerService } from "../reader/readerService.js";

/** Cap on the in-memory event log to avoid unbounded growth. */
const MAX_EVENTS = 50;

/** State surfaced by {@link useReaderEvents}. */
export interface ReaderEventsState {
  /** Rolling log of the most recent reader events (oldest-first, capped). */
  readonly events: readonly ReaderEvent[];
  /** The most recent check-in/check-out scan, or `null` until one arrives. */
  readonly lastScan: ScanEvent | null;
  /** The most recent connection-status event, or `null` until one arrives. */
  readonly lastStatus: StatusEvent | null;
  /** Whether the reader is currently connected (per the last status event). */
  readonly connected: boolean;
}

/**
 * Subscribe to reader events for the lifetime of the calling screen. The
 * optional `handler` is invoked for every event (always the latest closure,
 * via a ref, so it sees fresh props/state without re-subscribing); the hook
 * also returns the rolling event state. Plans 006/008 reuse this hook.
 */
export function useReaderEvents(
  handler?: (event: ReaderEvent) => void,
): ReaderEventsState {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const [state, setState] = useState<ReaderEventsState>({
    events: [],
    lastScan: null,
    lastStatus: null,
    connected: readerService.connected,
  });

  useEffect(() => {
    const unsubscribe = readerService.subscribe((event) => {
      handlerRef.current?.(event);
      setState((prev) => {
        const events = [...prev.events, event].slice(-MAX_EVENTS);
        const lastScan = event.event === "scan" ? event : prev.lastScan;
        const lastStatus = event.event === "status" ? event : prev.lastStatus;
        const connected = event.event === "status" ? event.connected : prev.connected;
        return { events, lastScan, lastStatus, connected };
      });
    });
    return unsubscribe;
  }, []);

  return state;
}
