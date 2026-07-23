/**
 * BOL upload queue (plan 010, Phase 3). Uploads each BOL page artifact to
 * Vercel Blob via a server-issued, short-lived client-upload grant, then sets
 * `storage_url` on the BOL doc so the public tag page can link it.
 *
 * Idempotent: an entry is keyed by `(docId, contentHash)`. Re-enqueuing the
 * same content is a no-op; a completed entry is reused (never re-uploaded).
 * Retries use the same jittered backoff as the sync coordinator and cap out.
 * Errors are REDACTED — the upload URL, grant token, and blob bytes never
 * appear in recorded messages; only an HTTP status (when known) plus a short
 * sanitized tag survive.
 *
 * Pure + injectable: storage (AsyncStorage in the app, an array in tests), the
 * grant provider (a server route in the app, a stub in tests), `fetch`, and the
 * clock are all injected, so the queue is unit-tested deterministically.
 */

import { nextBackoffMs } from "./backoff";

export interface BlobGrant {
  /** Signed client-upload URL from Vercel Blob (presigned PUT) or a server proxy. */
  uploadUrl: string;
  /** HTTP method (default PUT). */
  method?: string;
  /** Extra headers to send with the upload (e.g. `content-type` for a presigned PUT). */
  headers?: Record<string, string>;
  /**
   * The canonical object URL the upload will produce, when the server knows it
   * ahead of time (e.g. a Vercel Blob presigned PUT to a content-addressed
   * pathname). When set, the queue records this as the entry's `storage_url` on
   * a 200 without parsing the upload response body. When unset, the queue falls
   * back to parsing the response body for `url` (the proxy/`put()` shape).
   */
  storageUrl?: string;
}

/** Context the grant provider needs to mint a content-bound upload grant. */
export interface GrantRequest {
  docId: string;
  contentHash: string;
  contentType: string;
  sizeBytes: number;
}

export interface GrantProvider {
  /** Request a short-lived upload grant bound to one artifact's content. */
  getUploadGrant(req: GrantRequest): Promise<BlobGrant>;
}

export interface QueueStorage {
  load(): Promise<QueueEntry[]>;
  save(entries: QueueEntry[]): Promise<void>;
}

export interface UploadClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export interface QueueConfig {
  baseMs: number;
  maxBackoffMs: number;
  maxAttempts: number;
  rand: () => number;
}

export interface QueueCallbacks {
  /** Called once an upload completes; the app sets `storage_url` on the doc. */
  onUploaded?: (docId: string, storageUrl: string) => void;
  /** Called with a redacted error when an entry is dead-lettered. */
  onDeadLetter?: (docId: string, reason: RedactedError) => void;
}

export type EntryStatus = "pending" | "uploading" | "done" | "dead";

export interface QueueEntry {
  docId: string;
  contentHash: string;
  /** Content type of the artifact (e.g. image/jpeg, application/pdf). */
  contentType: string;
  /** Artifact size in bytes (sent to the grant endpoint for size-capped grants). */
  sizeBytes: number;
  /** The object URL the upload produced (set on success). */
  storageUrl: string | null;
  status: EntryStatus;
  attempts: number;
  /** Redacted last error, if any. */
  lastError: RedactedError | null;
  /** Scheduled retry time (ms epoch), if pending retry. */
  nextAttemptAt: number | null;
}

export interface RedactedError {
  /** Short sanitized tag, e.g. "http", "network", "grant". Never the URL/token. */
  kind: string;
  /** HTTP status when known; null otherwise. */
  status: number | null;
}

const DEFAULT_CONFIG: QueueConfig = {
  baseMs: 2_000,
  maxBackoffMs: 60_000,
  maxAttempts: 8,
  rand: Math.random,
};

export class BolUploadQueue {
  private _entries: QueueEntry[] = [];
  private _timer: number | null = null;
  private _processing = false;

  private readonly _grant: GrantProvider;
  private readonly _storage: QueueStorage;
  private readonly _fetch: typeof fetch;
  private readonly _clock: UploadClock;
  private readonly _cfg: QueueConfig;
  private readonly _cb: QueueCallbacks;

  constructor(deps: {
    grant: GrantProvider;
    storage: QueueStorage;
    fetchImpl: typeof fetch;
    clock: UploadClock;
    config?: Partial<QueueConfig>;
    callbacks?: QueueCallbacks;
  }) {
    this._grant = deps.grant;
    this._storage = deps.storage;
    this._fetch = deps.fetchImpl;
    this._clock = deps.clock;
    this._cfg = { ...DEFAULT_CONFIG, ...deps.config };
    this._cb = deps.callbacks ?? {};
  }

  /** Load any persisted queue (after a restart) and resume pending work. */
  async restore(): Promise<void> {
    this._entries = await this._storage.load();
    this._scheduleNext();
  }

  /**
   * Enqueue an upload. `blob` is the artifact bytes; `contentHash` is a stable
   * SHA-256 hex of those bytes (the app computes it); `contentType`/`sizeBytes`
   * describe the artifact for the size-capped, content-bound grant. Returns the
   * storage URL when the content is already uploaded, or null when freshly queued.
   */
  async enqueue(
    docId: string,
    contentHash: string,
    contentType: string,
    sizeBytes: number,
    blob: Blob,
  ): Promise<string | null> {
    const existing = this._entries.find(
      (e) => e.docId === docId && e.contentHash === contentHash,
    );
    if (existing) {
      if (existing.status === "done" && existing.storageUrl) return existing.storageUrl;
      return null; // already pending/retrying
    }
    // Any prior (different-content) entry for the same doc is superseded.
    this._entries = this._entries.filter((e) => e.docId !== docId);
    this._entries.push({
      docId,
      contentHash,
      contentType,
      sizeBytes,
      storageUrl: null,
      status: "pending",
      attempts: 0,
      lastError: null,
      nextAttemptAt: this._clock.now(),
    });
    // Stash the blob on the entry via a side map keyed by docId+hash.
    this._blobs.set(blobKey(docId, contentHash), blob);
    await this._persist();
    this._scheduleNext();
    return null;
  }

  /** Force one processing pass now (e.g. on reconnect). */
  async flush(): Promise<void> {
    await this._process();
  }

  get size(): number {
    return this._entries.filter((e) => e.status !== "done" && e.status !== "dead").length;
  }

  dispose(): void {
    if (this._timer !== null) this._clock.clearTimeout(this._timer);
    this._timer = null;
  }

  // ---- internals -----------------------------------------------------------

  private _blobs = new Map<string, Blob>();

  private _scheduleNext(): void {
    if (this._timer !== null) {
      this._clock.clearTimeout(this._timer);
      this._timer = null;
    }
    const now = this._clock.now();
    const nextReady = this._entries
      .filter((e) => e.status === "pending" && e.nextAttemptAt !== null)
      .map((e) => e.nextAttemptAt as number)
      .reduce<number | null>((min, t) => (min === null || t < min ? t : min), null);
    if (nextReady === null) return;
    const delay = Math.max(0, nextReady - now);
    this._timer = this._clock.setTimeout(() => {
      this._timer = null;
      void this._process();
    }, delay);
  }

  private async _process(): Promise<void> {
    if (this._processing) return;
    this._processing = true;
    try {
      const now = this._clock.now();
      const ready = this._entries.filter(
        (e) => e.status === "pending" && (e.nextAttemptAt ?? 0) <= now,
      );
      for (const entry of ready) {
        await this._processEntry(entry);
      }
      await this._persist();
      this._scheduleNext();
    } finally {
      this._processing = false;
    }
  }

  private async _processEntry(entry: QueueEntry): Promise<void> {
    const key = blobKey(entry.docId, entry.contentHash);
    const blob = this._blobs.get(key);
    if (!blob) {
      // Lost the in-memory blob (e.g. process restart before persist). Dead-letter.
      entry.status = "dead";
      entry.lastError = { kind: "missing-blob", status: null };
      this._cb.onDeadLetter?.(entry.docId, entry.lastError);
      return;
    }
    entry.status = "uploading";
    entry.attempts += 1;
    try {
      const grant = await this._grant.getUploadGrant({
        docId: entry.docId,
        contentHash: entry.contentHash,
        contentType: entry.contentType,
        sizeBytes: entry.sizeBytes,
      });
      const method = grant.method ?? "PUT";
      const res = await this._fetch(grant.uploadUrl, {
        method,
        body: blob,
        headers: grant.headers,
      });
      if (res.status >= 200 && res.status < 300) {
        // Prefer the grant's server-known `storageUrl` (presigned PUT to a
        // content-addressed pathname); fall back to parsing the response body
        // for `url` (the proxy/`put()` shape). Redacted: never logged.
        const storageUrl = grant.storageUrl ?? (await this._extractStorageUrl(res, grant));
        entry.status = "done";
        entry.storageUrl = storageUrl;
        entry.lastError = null;
        entry.nextAttemptAt = null;
        this._blobs.delete(key);
        this._cb.onUploaded?.(entry.docId, storageUrl);
        return;
      }
      this._recordFailure(entry, { kind: "http", status: res.status });
    } catch (e) {
      const status = extractStatus(e);
      this._recordFailure(entry, { kind: status === null ? "network" : "http", status });
    }
  }

  private async _extractStorageUrl(res: Response, grant: BlobGrant): Promise<string> {
    try {
      const text = await res.text();
      if (text) {
        const parsed = JSON.parse(text);
        const url = parsed?.url ?? parsed?.blob?.url;
        if (typeof url === "string") return url;
      }
    } catch {
      // Non-JSON body; fall through.
    }
    // Fall back to the grant URL itself (it IS the object URL for many Blob
    // configs). Redacted: never logged.
    return grant.uploadUrl;
  }

  private _recordFailure(entry: QueueEntry, err: RedactedError): void {
    entry.lastError = err;
    if (entry.attempts >= this._cfg.maxAttempts) {
      entry.status = "dead";
      entry.nextAttemptAt = null;
      this._cb.onDeadLetter?.(entry.docId, err);
      return;
    }
    entry.status = "pending";
    const delay = nextBackoffMs(entry.attempts - 1, {
      baseMs: this._cfg.baseMs,
      maxMs: this._cfg.maxBackoffMs,
      rand: this._cfg.rand,
    });
    entry.nextAttemptAt = this._clock.now() + delay;
  }

  private async _persist(): Promise<void> {
    // Persist metadata only — never the blob bytes.
    await this._storage.save(this._entries.map(redactEntryForStorage));
  }
}

function blobKey(docId: string, contentHash: string): string {
  return `${docId}::${contentHash}`;
}

function redactEntryForStorage(e: QueueEntry): QueueEntry {
  return { ...e }; // entries already contain only redacted metadata
}

function extractStatus(e: unknown): number | null {
  if (e && typeof e === "object" && "status" in e) {
    const s = (e as { status: unknown }).status;
    return typeof s === "number" ? s : null;
  }
  return null;
}
