/**
 * {@link QueueStorage} backed by `AsyncStorage` (plan 010, Phase 3). Persists only
 * redacted queue metadata (never blob bytes) under one key, so a killed/restarted
 * app can resume pending uploads via {@link BolUploadQueue.restore}.
 *
 * The storage interface is injected so unit tests use an in-memory fake instead
 * of the real RN module.
 */

import type { QueueEntry, QueueStorage } from "./bolQueue";

/** Minimal AsyncStorage surface the queue store needs. */
export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export const BOL_QUEUE_KEY = "rfid.bol.queue";

export class AsyncStorageQueueStorage implements QueueStorage {
  constructor(private readonly _store: AsyncStorageLike) {}

  async load(): Promise<QueueEntry[]> {
    try {
      const raw = await this._store.getItem(BOL_QUEUE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as QueueEntry[];
      return Array.isArray(parsed) ? (parsed as QueueEntry[]) : [];
    } catch {
      return [];
    }
  }

  async save(entries: QueueEntry[]): Promise<void> {
    try {
      await this._store.setItem(BOL_QUEUE_KEY, JSON.stringify(entries));
    } catch {
      // AsyncStorage may throw in restricted storage; the in-memory queue still
      // proceeds for this session. Redacted metadata only — safe to swallow.
    }
  }
}
