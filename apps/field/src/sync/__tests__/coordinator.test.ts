import { describe, expect, it, vi } from "vitest";
import {
  SyncCoordinator,
  type SyncEngine,
  type CredentialProvider,
  type MetaProvider,
} from "../coordinator";
import { AuthError, TransientError } from "../errors";
import { FakeClock } from "./fakeClock";

/** Resolve on the next microtask so pending async cycles settle between steps. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

type Step = "push" | "pull";

function makeFakes() {
  const clock = new FakeClock();
  const calls: Step[] = [];
  let pushImpl: () => Promise<void> = async () => {};
  let pullImpl: () => Promise<boolean> = async () => false;
  let refreshImpl: () => Promise<void> = async () => {};
  let remoteSchema: number | null = null;
  const statuses: string[] = [];

  const engine: SyncEngine = {
    push: () => {
      calls.push("push");
      return pushImpl();
    },
    pull: () => {
      calls.push("pull");
      return pullImpl();
    },
  };
  const creds: CredentialProvider = {
    refreshSyncToken: () => refreshImpl(),
  };
  const meta: MetaProvider = {
    getRemoteSchemaVersion: async () => remoteSchema,
  };

  const setPush = (fn: () => Promise<void>) => (pushImpl = fn);
  const setPull = (fn: () => Promise<boolean>) => (pullImpl = fn);
  const setRefresh = (fn: () => Promise<void>) => (refreshImpl = fn);
  const setRemoteSchema = (v: number | null) => (remoteSchema = v);

  return {
    clock,
    calls,
    statuses,
    engine,
    creds,
    meta,
    setPush,
    setPull,
    setRefresh,
    setRemoteSchema,
    make: (opts?: { supported?: number; debounceMs?: number; foregroundIntervalMs?: number }) =>
      new SyncCoordinator({
        engine,
        creds,
        meta,
        clock,
        supportedSchemaVersion: opts?.supported ?? 5,
        config: {
          debounceMs: opts?.debounceMs ?? 100,
          foregroundIntervalMs: opts?.foregroundIntervalMs ?? 1_000,
          baseMs: 1_000,
          maxBackoffMs: 30_000,
          rand: () => 0.5,
        },
        callbacks: { onStatus: (s) => statuses.push(s) },
      }),
  };
}

describe("SyncCoordinator", () => {
  it("runs push then pull on startup and reports synced", async () => {
    const f = makeFakes();
    const c = f.make();
    c.start();
    await flush();
    expect(f.calls).toEqual(["push", "pull"]);
    expect(c.status).toBe("synced");
    expect(c.lastSyncedAt).toBe(0);
  });

  it("serializes overlapping triggers into one extra cycle", async () => {
    const f = makeFakes();
    let pushCalls = 0;
    let resolveFirst: () => void = () => {};
    // First push is held open (deferred); subsequent pushes resolve at once so
    // the coalesced cycle 2 can complete.
    f.setPush(() => {
      pushCalls += 1;
      if (pushCalls === 1) {
        return new Promise<void>((r) => {
          resolveFirst = r;
        });
      }
      return Promise.resolve();
    });
    const c = f.make();
    c.start(); // cycle 1 in flight (push pending)
    await flush();
    expect(f.calls).toEqual(["push"]);
    c.trigger("manual"); // arrives while running → coalesced
    c.trigger("manual"); // second coalesce should NOT queue a third cycle
    await flush();
    resolveFirst(); // finish cycle 1
    await flush();
    // cycle 2 (the single coalesced drain) runs push+pull
    expect(f.calls.filter((s) => s === "push").length).toBe(2);
    expect(f.calls.filter((s) => s === "pull").length).toBe(2);
  });

  it("coalesces a burst of mutations into one debounced cycle", async () => {
    const f = makeFakes();
    const c = f.make({ debounceMs: 100 });
    c.trigger("mutation");
    c.trigger("mutation");
    c.trigger("mutation");
    await flush();
    // No cycle yet — debounced.
    expect(f.calls).toEqual([]);
    expect(c.status).toBe("pending");
    await f.clock.advance(100);
    await flush();
    // Exactly one cycle for the whole burst.
    expect(f.calls).toEqual(["push", "pull"]);
  });

  it("retries with backoff on transient failure, then succeeds", async () => {
    const f = makeFakes();
    let pushFails = true;
    f.setPush(async () => {
      if (pushFails) throw new TransientError("net");
    });
    const c = f.make();
    c.start();
    await flush();
    expect(c.status).toBe("retrying");
    expect(f.clock.pendingCount()).toBe(1); // backoff timer scheduled
    // Make the next push succeed and fire the backoff timer.
    pushFails = false;
    await f.clock.advance(1_000); // first backoff (base 1s, jitter x1.0)
    await flush();
    expect(c.status).toBe("synced");
    expect(f.calls.filter((s) => s === "push").length).toBe(2);
  });

  it("refreshes the sync token once on 401, then succeeds", async () => {
    const f = makeFakes();
    let pushUnauthorized = true;
    const refresh = vi.fn(async () => {});
    f.setRefresh(refresh);
    f.setPush(async () => {
      if (pushUnauthorized) {
        pushUnauthorized = false;
        throw new AuthError("401");
      }
    });
    const c = f.make();
    c.start();
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(c.status).toBe("synced");
    expect(f.calls.filter((s) => s === "push").length).toBe(2); // initial + retry
  });

  it("goes reauth (no infinite retry) when refresh itself is unauthorized", async () => {
    const f = makeFakes();
    const refresh = vi.fn(async () => {
      throw new AuthError("revoked");
    });
    f.setRefresh(refresh);
    f.setPush(async () => {
      throw new AuthError("401");
    });
    const c = f.make();
    c.start();
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(c.status).toBe("reauth");
    // A later trigger must NOT start a cycle (terminal until re-link/upgrade).
    f.calls.length = 0;
    c.trigger("manual");
    c.trigger("foreground");
    await flush();
    expect(f.calls).toEqual([]);
  });

  it("goes reauth when a second 401 happens after a successful refresh", async () => {
    const f = makeFakes();
    const refresh = vi.fn(async () => {});
    f.setRefresh(refresh);
    let first = true;
    f.setPush(async () => {
      if (first) {
        first = false;
        throw new AuthError("401");
      }
      throw new AuthError("401"); // still bad after refresh
    });
    const c = f.make();
    c.start();
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(c.status).toBe("reauth");
  });

  it("blocks writes when the server schema is ahead", async () => {
    const f = makeFakes();
    f.setRemoteSchema(9);
    const c = f.make({ supported: 5 });
    c.start();
    await flush();
    expect(c.status).toBe("blocked");
    expect(f.calls).toEqual([]); // no push attempted
  });

  it("reset() escapes a terminal state and runs a fresh cycle", async () => {
    const f = makeFakes();
    f.setRefresh(async () => {
      throw new AuthError("revoked");
    });
    f.setPush(async () => {
      throw new AuthError("401");
    });
    const c = f.make();
    c.start();
    await flush();
    expect(c.status).toBe("reauth");
    // Operator re-links: refresh now works, push succeeds.
    f.setRefresh(async () => {});
    f.setPush(async () => {});
    c.reset();
    await flush();
    expect(c.status).toBe("synced");
  });

  it("schedules periodic foreground ticks while active and stops when inactive", async () => {
    const f = makeFakes();
    const c = f.make({ foregroundIntervalMs: 5_000 });
    c.setForegroundActive(true);
    // One tick scheduled.
    expect(f.clock.pendingCount()).toBe(1);
    await f.clock.advance(5_000);
    await flush();
    // The tick fired a foreground trigger → a cycle ran, and the next tick is scheduled.
    expect(f.calls.length).toBeGreaterThan(0);
    expect(f.clock.pendingCount()).toBe(1);
    c.setForegroundActive(false);
    expect(f.clock.pendingCount()).toBe(0);
  });

  it("reconnect and foreground triggers run an immediate cycle", async () => {
    const f = makeFakes();
    const c = f.make();
    c.onReconnect();
    await flush();
    expect(f.calls).toEqual(["push", "pull"]);
    f.calls.length = 0;
    c.onForeground();
    await flush();
    expect(f.calls).toEqual(["push", "pull"]);
  });
});
