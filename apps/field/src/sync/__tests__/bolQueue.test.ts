import { describe, expect, it, vi } from "vitest";
import { BolUploadQueue, type BlobGrant, type GrantProvider, type QueueEntry, type QueueStorage } from "../bolQueue";
import { FakeClock } from "./fakeClock";

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function makeGrantProvider(): GrantProvider & {
  grants: Map<string, BlobGrant>;
  calls: string[];
} {
  const grants = new Map<string, BlobGrant>();
  const calls: string[] = [];
  return {
    grants,
    calls,
    getUploadGrant: async (key: string) => {
      calls.push(key);
      const g = grants.get(key);
      if (!g) throw new Error("no grant configured for " + key);
      return g;
    },
  };
}

function makeStorage(): QueueStorage & { state: QueueEntry[] } {
  const obj = {
    state: [] as QueueEntry[],
    load: async () => obj.state as QueueEntry[],
    save: async (entries: QueueEntry[]) => {
      obj.state = entries;
    },
  };
  return obj;
}

function makeFetch() {
  const calls: { url: string; method: string; body: Blob }[] = [];
  let responder: (url: string) => Response = () =>
    new Response(JSON.stringify({ url: "https://blob.example/stored" }), { status: 200 });
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body as Blob });
    return responder(url);
  });
  return { fn, calls, setResponder: (r: (url: string) => Response) => (responder = r) };
}

describe("BolUploadQueue", () => {
  it("uploads on enqueue→flush and reports the storage URL", async () => {
    const clock = new FakeClock();
    const grant = makeGrantProvider();
    const storage = makeStorage();
    const fetchMock = makeFetch();
    grant.grants.set("hashA", { uploadUrl: "https://upload.example/a" });
    const uploaded = vi.fn();
    const q = new BolUploadQueue({
      grant,
      storage,
      fetchImpl: fetchMock.fn as unknown as typeof fetch,
      clock,
      config: { baseMs: 1_000, maxBackoffMs: 30_000, maxAttempts: 3, rand: () => 0.5 },
      callbacks: { onUploaded: uploaded },
    });
    const blob = new Blob(["bytes"], { type: "application/pdf" });
    const url = await q.enqueue("doc1", "hashA", blob);
    expect(url).toBeNull();
    await q.flush();
    expect(uploaded).toHaveBeenCalledWith("doc1", "https://blob.example/stored");
    expect(fetchMock.calls[0].method).toBe("PUT");
    expect(q.size).toBe(0);
  });

  it("is idempotent: re-enqueuing the same content does not re-upload", async () => {
    const clock = new FakeClock();
    const grant = makeGrantProvider();
    const storage = makeStorage();
    const fetchMock = makeFetch();
    grant.grants.set("hashA", { uploadUrl: "https://upload.example/a" });
    const q = new BolUploadQueue({
      grant,
      storage,
      fetchImpl: fetchMock.fn as unknown as typeof fetch,
      clock,
      config: { baseMs: 1_000, maxBackoffMs: 30_000, maxAttempts: 3, rand: () => 0.5 },
    });
    const blob = new Blob(["bytes"], { type: "application/pdf" });
    await q.enqueue("doc1", "hashA", blob);
    await q.flush();
    expect(fetchMock.calls.length).toBe(1);
    // Re-enqueue identical content → returns the stored URL, no new upload.
    const url = await q.enqueue("doc1", "hashA", blob);
    expect(url).toBe("https://blob.example/stored");
    expect(fetchMock.calls.length).toBe(1);
  });

  it("supersedes a prior entry when the same doc gets new content", async () => {
    const clock = new FakeClock();
    const grant = makeGrantProvider();
    const storage = makeStorage();
    const fetchMock = makeFetch();
    grant.grants.set("hashA", { uploadUrl: "https://upload.example/a" });
    grant.grants.set("hashB", { uploadUrl: "https://upload.example/b" });
    const q = new BolUploadQueue({
      grant,
      storage,
      fetchImpl: fetchMock.fn as unknown as typeof fetch,
      clock,
      config: { baseMs: 1_000, maxBackoffMs: 30_000, maxAttempts: 3, rand: () => 0.5 },
    });
    await q.enqueue("doc1", "hashA", new Blob(["a"]));
    await q.enqueue("doc1", "hashB", new Blob(["b"]));
    await q.flush();
    // Only the latest content (hashB) is uploaded.
    expect(grant.calls).toEqual(["hashB"]);
  });

  it("retries on a 500 with backoff, then succeeds", async () => {
    const clock = new FakeClock();
    const grant = makeGrantProvider();
    const storage = makeStorage();
    const fetchMock = makeFetch();
    grant.grants.set("hashA", { uploadUrl: "https://upload.example/a" });
    let attempts = 0;
    fetchMock.setResponder(
      () => (++attempts === 1 ? new Response("nope", { status: 500 }) : new Response(JSON.stringify({ url: "https://blob.example/ok" }), { status: 200 })),
    );
    const q = new BolUploadQueue({
      grant,
      storage,
      fetchImpl: fetchMock.fn as unknown as typeof fetch,
      clock,
      config: { baseMs: 1_000, maxBackoffMs: 30_000, maxAttempts: 3, rand: () => 0.5 },
    });
    await q.enqueue("doc1", "hashA", new Blob(["x"]));
    await q.flush();
    expect(fetchMock.calls.length).toBe(1); // first attempt failed
    expect(q.size).toBe(1);
    await clock.advance(1_000); // backoff fires (async _process)
    await flush(); // drain the timer-driven _process
    expect(fetchMock.calls.length).toBe(2);
    expect(storage.state.find((e) => e.docId === "doc1")?.status).toBe("done");
  });

  it("dead-letters after maxAttempts with a REDACTED error (no URL/token)", async () => {
    const clock = new FakeClock();
    const grant = makeGrantProvider();
    const storage = makeStorage();
    const fetchMock = makeFetch();
    grant.grants.set("hashA", { uploadUrl: "https://upload.example/SECRET-TOKEN" });
    fetchMock.setResponder(() => new Response("server error", { status: 500 }));
    const dead = vi.fn();
    const q = new BolUploadQueue({
      grant,
      storage,
      fetchImpl: fetchMock.fn as unknown as typeof fetch,
      clock,
      config: { baseMs: 1_000, maxBackoffMs: 30_000, maxAttempts: 2, rand: () => 0.5 },
      callbacks: { onDeadLetter: dead },
    });
    await q.enqueue("doc1", "hashA", new Blob(["x"]));
    await q.flush(); // attempt 1
    await clock.advance(1_000); // attempt 2 (async _process)
    await flush();
    expect(dead).toHaveBeenCalledTimes(1);
    const [docId, err] = dead.mock.calls[0];
    expect(docId).toBe("doc1");
    expect(err).toEqual({ kind: "http", status: 500 });
    // The redacted error must NOT contain the secret upload URL or token.
    expect(JSON.stringify(err)).not.toContain("SECRET-TOKEN");
    expect(JSON.stringify(err)).not.toContain("upload.example");
    expect(storage.state.find((e) => e.docId === "doc1")?.status).toBe("dead");
  });

  it("restore() resumes a persisted pending entry on restart", async () => {
    const clock = new FakeClock();
    const grant = makeGrantProvider();
    const storage = makeStorage();
    const fetchMock = makeFetch();
    grant.grants.set("hashA", { uploadUrl: "https://upload.example/a" });
    // Simulate a prior run that persisted a pending entry but lost the in-memory blob.
    storage.state = [
      {
        docId: "doc1",
        contentHash: "hashA",
        storageUrl: null,
        status: "pending",
        attempts: 0,
        lastError: null,
        nextAttemptAt: 0,
      },
    ];
    const dead = vi.fn();
    const q = new BolUploadQueue({
      grant,
      storage,
      fetchImpl: fetchMock.fn as unknown as typeof fetch,
      clock,
      config: { baseMs: 1_000, maxBackoffMs: 30_000, maxAttempts: 3, rand: () => 0.5 },
      callbacks: { onDeadLetter: dead },
    });
    await q.restore();
    await q.flush();
    // Blob is gone → dead-lettered with a redacted "missing-blob" error.
    expect(dead).toHaveBeenCalledWith("doc1", { kind: "missing-blob", status: null });
  });
});
