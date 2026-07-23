import { describe, expect, it } from "vitest";
import { AsyncStorageQueueStorage, BOL_QUEUE_KEY, type AsyncStorageLike } from "../bolQueueStorage";
import type { QueueEntry } from "../bolQueue";

function fakeStore(): AsyncStorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => {
      map.set(k, v);
    },
  };
}

const ENTRY: QueueEntry = {
  docId: "doc1",
  contentHash: "a".repeat(64),
  contentType: "image/jpeg",
  sizeBytes: 5,
  storageUrl: null,
  status: "pending",
  attempts: 1,
  lastError: { kind: "http", status: 500 },
  nextAttemptAt: 99,
};

describe("AsyncStorageQueueStorage", () => {
  it("load() returns [] when nothing is stored", async () => {
    const s = new AsyncStorageQueueStorage(fakeStore());
    expect(await s.load()).toEqual([]);
  });

  it("save() then load() round-trips entries", async () => {
    const store = fakeStore();
    const s = new AsyncStorageQueueStorage(store);
    await s.save([ENTRY]);
    const loaded = await s.load();
    expect(loaded).toEqual([ENTRY]);
    expect(store.map.get(BOL_QUEUE_KEY)).toBe(JSON.stringify([ENTRY]));
  });

  it("load() returns [] on corrupt JSON (never throws)", async () => {
    const store = fakeStore();
    store.map.set(BOL_QUEUE_KEY, "{not json");
    const s = new AsyncStorageQueueStorage(store);
    expect(await s.load()).toEqual([]);
  });

  it("load() returns [] on a non-array JSON value", async () => {
    const store = fakeStore();
    store.map.set(BOL_QUEUE_KEY, JSON.stringify({ not: "an array" }));
    const s = new AsyncStorageQueueStorage(store);
    expect(await s.load()).toEqual([]);
  });

  it("save() swallows a storage failure (in-memory queue proceeds)", async () => {
    const store: AsyncStorageLike = {
      getItem: async () => null,
      setItem: async () => {
        throw new Error("quota");
      },
    };
    const s = new AsyncStorageQueueStorage(store);
    await expect(s.save([ENTRY])).resolves.toBeUndefined();
  });
});
