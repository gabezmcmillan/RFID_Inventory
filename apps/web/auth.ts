/**
 * Better Auth CLI entrypoint — consumed by `@better-auth/cli`
 * (`pnpm --filter @rfid/web auth:generate` / `auth:migrate`) to emit/apply the
 * auth tables. Lives at the app root as `auth.ts` so the CLI discovers it
 * automatically (it searches `./`, `./lib`, `./utils`, and `./src`); `--config`
 * is passed explicitly in the scripts for clarity.
 *
 * Like `drizzle.config.ts`, this runs outside the Next request scope, so reading
 * `process.env` here is the one sanctioned exception. The CLI only introspects
 * the config to emit/apply schema migrations against the **separate** auth
 * database — it never serves a request — so `BETTER_AUTH_URL` is not needed here
 * (a per-app runtime concern). Auth tables are kept out of `packages/domain` by
 * living here, against their own database. The instance is built by the same
 * {@link createAuth} the app uses, so the CLI and the runtime never drift.
 */
import { createAuth } from "./src/lib/auth";

const auth = createAuth();
if (auth === null) {
  throw new Error(
    "AUTH_DATABASE_URL + BETTER_AUTH_SECRET must be set to run Better Auth migrations.",
  );
}

export { auth };
