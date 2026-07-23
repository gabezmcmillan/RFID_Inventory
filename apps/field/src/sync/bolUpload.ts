/**
 * BOL upload queue singleton + enqueue helper (plan 010, Phase 3). Wires the
 * pure {@link BolUploadQueue} to the server grant endpoint (via
 * {@link ServerBolGrantProvider}), AsyncStorage persistence, the real clock,
 * and an `onUploaded` callback that records the blob URL on the `bol_docs` row
 * via {@link setBolDocStorageUrl}.
 *
 * The queue is built once after the domain database opens (see
 * {@link buildBolQueue}) and restored so a restarted app resumes pending
 * uploads. {@link enqueueBolArtifact} is the call-site helper the capture
 * functions use: it reads the artifact bytes, computes a SHA-256 content hash,
 * and enqueues (idempotent by `(docId, contentHash)`).
 *
 * ON-DEVICE VALIDATION REQUIRED: the upload body is a RN `Blob` built from the
 * artifact bytes; RN `fetch` must accept a Blob body for the PUT to the
 * Vercel Blob presigned URL. This is wired but not runtime-verified off-device
 * (the server mints the presigned URL with the official `@vercel/blob` SDK; see
 * `bolGrantProvider.ts`).
 */

import { sha256 } from "js-sha256";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { setBolDocStorageUrl, type DomainDb } from "@rfid/domain";

import { getLinkedToken, getServerUrl } from "../auth/credential";
import { BolUploadQueue, type UploadClock } from "./bolQueue";
import { ServerBolGrantProvider } from "./bolGrantProvider";
import { AsyncStorageQueueStorage } from "./bolQueueStorage";
import { readBytes } from "../bol/documentStore";

/**
 * Hard cap on a single BOL artifact upload. The server grant endpoint enforces
 * the same cap on the presigned PUT (`maximumSizeInBytes` is bound into the
 * delegation token, enforced by the CDN); this pre-flight guard avoids
 * streaming an oversized body just to have it rejected. Presigned PUT uploads
 * go directly device→Blob storage (no Vercel serverless body cap), so this is
 * generous (25 MB — a scanned JPEG page or a small PDF). The document scanner
 * already emits compressed JPEG pages well under this limit; a picked artifact
 * that exceeds it is skipped (the `storage_url` stays null and the tag page
 * shows no link) rather than dead-lettered after repeated retries.
 */
export const MAX_BOL_UPLOAD_BYTES = 25 * 1024 * 1024;

let queue: BolUploadQueue | null = null;
let queueDb: DomainDb | null = null;

/** Real clock for the upload queue (RN `setTimeout` returns a number on Hermes). */
const realClock: UploadClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
};

/** Build (and restore) the singleton queue for the open domain database. */
export async function buildBolQueue(db: DomainDb): Promise<BolUploadQueue> {
  queueDb = db;
  const q = new BolUploadQueue({
    grant: new ServerBolGrantProvider({
      fetchImpl: fetch,
      getServerUrl,
      getBearer: getLinkedToken,
    }),
    storage: new AsyncStorageQueueStorage(AsyncStorage),
    fetchImpl: fetch,
    clock: realClock,
    callbacks: {
      onUploaded: (docId, storageUrl) => {
        if (queueDb) void setBolDocStorageUrl(queueDb, docId, storageUrl);
      },
    },
  });
  await q.restore();
  queue = q;
  return q;
}

/** Drop the singleton (e.g. on unlink/relink). */
export function disposeBolQueue(): void {
  queue?.dispose();
  queue = null;
  queueDb = null;
}

/** The live queue, or null before {@link buildBolQueue}. */
export function getBolQueue(): BolUploadQueue | null {
  return queue;
}

/**
 * Read an artifact's bytes, hash them, and enqueue an upload. Returns the stored
 * URL if this content was already uploaded, or null when freshly queued. Safe
 * to fire-and-forget after a capture: the queue schedules its own retries.
 */
export async function enqueueBolArtifact(
  db: DomainDb,
  docId: string,
  uri: string,
  contentType: string,
): Promise<string | null> {
  const q = queue ?? (await buildBolQueue(db));
  const bytes = await readBytes(uri);
  const contentHash = sha256(bytes);
  const sizeBytes = bytes.byteLength;
  // Pre-flight the size cap so an oversized artifact is skipped rather than
  // streamed to the CDN and rejected (the grant also enforces this server-side).
  if (sizeBytes > MAX_BOL_UPLOAD_BYTES) {
    return null;
  }
  const blob = new Blob([new Uint8Array(bytes)], { type: contentType });
  return q.enqueue(docId, contentHash, contentType, sizeBytes, blob);
}
