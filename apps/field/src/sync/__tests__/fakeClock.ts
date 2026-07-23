/** Deterministic fake clock for coordinator/queue tests. Advances time only when
 *  the test drives it, and records scheduled timers so tests can fire them in
 *  order. Mirrors the `Clock`/`UploadClock` interfaces the production code uses. */
export interface ScheduledTimer {
  id: number;
  fireAt: number;
  fn: () => void;
}

export class FakeClock {
  nowMs = 0;
  private nextId = 1;
  private timers: ScheduledTimer[] = [];
  private cancelled = new Set<number>();

  now(): number {
    return this.nowMs;
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.push({ id, fireAt: this.nowMs + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(id: number): void {
    this.cancelled.add(id);
  }

  /** Advance virtual time, firing any due timers in scheduled order. */
  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    // Fire timers whose fireAt <= target, in chronological order, repeatedly
    // (a fired timer may schedule another that falls within the window).
    for (;;) {
      const due = this.timers
        .filter((t) => !this.cancelled.has(t.id) && t.fireAt <= target)
        .sort((a, b) => a.fireAt - b.fireAt)[0];
      if (!due) break;
      this.nowMs = due.fireAt;
      this.timers = this.timers.filter((t) => t.id !== due.id);
      this.cancelled.delete(due.id);
      await due.fn();
    }
    this.nowMs = target;
  }

  /** Fire the single next due timer regardless of its fireAt (for ordered tests). */
  async fireNext(): Promise<void> {
    const next = this.timers
      .filter((t) => !this.cancelled.has(t.id))
      .sort((a, b) => a.fireAt - b.fireAt)[0];
    if (!next) return;
    this.nowMs = next.fireAt;
    this.timers = this.timers.filter((t) => t.id !== next.id);
    this.cancelled.delete(next.id);
    await next.fn();
  }

  pendingCount(): number {
    return this.timers.filter((t) => !this.cancelled.has(t.id)).length;
  }
}
