/**
 * Error types the sync engine / credential provider throw so the coordinator
 * can classify a failure without inspecting HTTP bodies. `AuthError` ⇒ the
 * short-lived sync token is expired or revoked (401/403): the coordinator
 * refreshes once, then surfaces `reauth` if it persists. `TransientError` ⇒ a
 * network/timeout/server hiccup: retry with backoff. Anything else is treated
 * as transient.
 */
export class AuthError extends Error {
  constructor(message = "auth") {
    super(message);
    this.name = "AuthError";
  }
}

export class TransientError extends Error {
  constructor(message = "transient") {
    super(message);
    this.name = "TransientError";
  }
}

export function isAuthError(e: unknown): e is AuthError {
  return e instanceof AuthError;
}

export function isTransientError(e: unknown): boolean {
  return e instanceof TransientError;
}
