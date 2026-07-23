/**
 * Jittered exponential backoff for the sync retry schedule (plan 010, Phase 3).
 *
 * Caps grow per the plan: a short bounded exponential schedule with jitter so
 * retrying clients don't synchronize. Pure (no timers / no I/O) so it is unit
 * tested with a fixed PRNG.
 */

/** Default cap on the base (pre-jitter) delay, in milliseconds. */
export const DEFAULT_MAX_BACKOFF_MS = 30_000;

/** Default base unit: 1s, doubling per attempt. */
export const DEFAULT_BASE_MS = 1_000;

/**
 * Compute the base (pre-jitter) backoff for a given attempt number (0-based:
 * the first retry is attempt 0). Doubles each step up to `maxMs`.
 */
export function baseBackoffMs(
  attempt: number,
  baseMs = DEFAULT_BASE_MS,
  maxMs = DEFAULT_MAX_BACKOFF_MS,
): number {
  const a = Math.max(0, Math.trunc(attempt));
  const raw = baseMs * 2 ** a;
  return Math.min(raw, maxMs);
}

/**
 * Apply ±25% jitter to a base delay. `rand` is a function returning a float in
 * [0, 1) so tests can inject a deterministic PRNG; production passes
 * `Math.random`.
 */
export function jitter(baseMs: number, rand: () => number = Math.random): number {
  // Map rand() in [0,1) to a multiplier in [0.75, 1.25).
  const mult = 0.75 + rand() * 0.5;
  return Math.round(baseMs * mult);
}

/**
 * Full backoff for an attempt: jittered exponential, capped. Returns the delay
 * in milliseconds to wait before the next retry.
 */
export function nextBackoffMs(
  attempt: number,
  opts: { baseMs?: number; maxMs?: number; rand?: () => number } = {},
): number {
  return jitter(
    baseBackoffMs(attempt, opts.baseMs, opts.maxMs),
    opts.rand,
  );
}
