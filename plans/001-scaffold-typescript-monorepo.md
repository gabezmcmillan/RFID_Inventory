# Plan 001: Scaffold the TypeScript monorepo (field app, web app, domain package)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 79443fb..HEAD -- package.json pnpm-workspace.yaml apps/field apps/web packages/domain packages/reader-protocol`
> If any in-scope path already exists or changed since this plan was written,
> compare against the "Current state" section before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: migration
- **Planned at**: commit `79443fb`, 2026-07-22

## Why this matters

This repo currently contains a Python warehouse app (`apps/warehouse/`) and a
Python cloud app (`apps/cloud/`). The project is being rewritten as an Expo
(React Native) iPhone app plus a Next.js web app sharing a TypeScript domain
package, with Turso as the database (see `plans/README.md`). Every later plan
(002–010) creates code inside the workspace this plan sets up. Getting the
workspace, TypeScript config, and test runner right once means nine later
plans never fight tooling.

## Current state

- The repo root has `pyproject.toml` (a **uv Python workspace** — do not touch
  it), `README.md`, `CONTEXT.md`, `.gitignore`, `apps/warehouse/`,
  `apps/cloud/`, `packages/contract/` (Python), and `plans/`.
- There is **no** `package.json`, no `pnpm-workspace.yaml`, no JS tooling at
  the root. `apps/field/`, `apps/web/`, `packages/domain/`, and
  `packages/reader-protocol/` do not exist.
- The existing Python apps must keep working untouched; they are retired only
  in plan 010.
- Root `.gitignore` currently covers Python artifacts (`.venv`, `__pycache__`,
  `inventory.db`, `scans/`, `settings.ini`, `dist/`, `build/`). It does not
  cover `node_modules` yet.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Node present | `node --version` | v20.x or newer |
| pnpm present | `pnpm --version` | 9.x or newer (if missing: `corepack enable && corepack prepare pnpm@latest --activate`) |
| Install | `pnpm install` (repo root) | exit 0 |
| Typecheck all | `pnpm -r typecheck` | exit 0 |
| Test domain | `pnpm --filter @rfid/domain test` | all pass |

## Scope

**In scope** (create only):
- Root: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, additions to `.gitignore`
- `apps/field/` (new Expo app)
- `apps/web/` (new Next.js app)
- `packages/domain/` (new TS package, stub only — plan 002 fills it)
- `packages/reader-protocol/` (new TS package, stub only — plan 003 fills it)

**Out of scope** (do NOT touch):
- `apps/warehouse/`, `apps/cloud/`, `packages/contract/` — the running Python
  system. No file inside them may change.
- `pyproject.toml`, `uv.lock` — the Python workspace definition.
- Do not run `expo prebuild`, do not create iOS credentials, do not install
  Turso packages yet (plans 002/010 do).

## Git workflow

- Branch: `advisor/001-scaffold-typescript-monorepo`
- Commit style observed in `git log`: short imperative sentences, e.g.
  "Update cloud app configuration and documentation". Match it, e.g.
  "Scaffold pnpm workspace with Expo field app and Next.js web app".
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Root workspace files

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/field"
  - "apps/web"
  - "packages/domain"
  - "packages/reader-protocol"
```

Create root `package.json`:

```json
{
  "name": "rfid-inventory",
  "private": true,
  "engines": { "node": ">=20" },
  "scripts": {
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test"
  }
}
```

Create `tsconfig.base.json` (every package extends this):

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "skipLibCheck": true,
    "noUncheckedIndexedAccess": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

Append to root `.gitignore` (keep existing content):

```
node_modules/
.expo/
.next/
*.tsbuildinfo
```

**Verify**: `cat pnpm-workspace.yaml` → shows the four packages; `git status` →
only new/modified root files listed, nothing under `apps/warehouse` or
`apps/cloud`.

### Step 2: Domain and reader-protocol package stubs

Create `packages/domain/package.json`:

```json
{
  "name": "@rfid/domain",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

Create `packages/domain/tsconfig.json` extending `../../tsconfig.base.json`
with `"include": ["src"]`. Create `packages/domain/src/index.ts` containing
`export const DOMAIN_PACKAGE = "@rfid/domain";` and a smoke test
`packages/domain/src/index.test.ts`:

```ts
import { expect, test } from "vitest";
import { DOMAIN_PACKAGE } from "./index";

test("package loads", () => {
  expect(DOMAIN_PACKAGE).toBe("@rfid/domain");
});
```

Create `packages/reader-protocol/` identically (name `@rfid/reader-protocol`,
same scripts/devDependencies, its own stub export and smoke test).

**Verify**: `pnpm install && pnpm --filter @rfid/domain test && pnpm --filter @rfid/reader-protocol test` → both suites pass (1 test each).

### Step 3: Expo field app

From `apps/`, run:

```
pnpm create expo-app@latest field --template blank-typescript
```

Then, inside `apps/field/package.json`:
- set `"name": "@rfid/field"`,
- add scripts: `"typecheck": "tsc --noEmit"`, `"test": "echo \"no tests yet\" && exit 0"`,
- add dependency `"@rfid/domain": "workspace:*"` and
  `"@rfid/reader-protocol": "workspace:*"`.

Expo in a pnpm monorepo needs Metro told about the workspace root. Create
`apps/field/metro.config.js`:

```js
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
module.exports = config;
```

In `apps/field/App.tsx`, import and render `DOMAIN_PACKAGE` from
`@rfid/domain` somewhere visible (proves workspace resolution through Metro's
TS path).

**Verify**: `pnpm install` (root) → exit 0; `pnpm --filter @rfid/field typecheck`
→ exit 0. Then `pnpm --filter @rfid/field exec expo export --platform ios`
→ completes without module-resolution errors (this bundles JS without needing
a device or Xcode).

### Step 4: Next.js web app

From `apps/`, run:

```
pnpm create next-app@latest web --typescript --app --no-tailwind --eslint --src-dir --import-alias "@/*" --use-pnpm
```

Then in `apps/web/package.json`: set `"name": "@rfid/web"`, add
`"typecheck": "tsc --noEmit"` and `"test": "echo \"no tests yet\" && exit 0"`
scripts, and add `"@rfid/domain": "workspace:*"`. In
`apps/web/next.config.ts` add `transpilePackages: ["@rfid/domain"]`.
Import `DOMAIN_PACKAGE` in `apps/web/src/app/page.tsx` and render it.

**Verify**: `pnpm --filter @rfid/web typecheck` → exit 0;
`pnpm --filter @rfid/web build` → build succeeds.

### Step 5: Full-workspace gate

**Verify**: from the repo root: `pnpm -r typecheck` → exit 0 for all four
packages; `pnpm -r test` → domain + reader-protocol suites pass, field/web
no-op. `git status` → no modified files under `apps/warehouse/`,
`apps/cloud/`, or `packages/contract/`.

## Test plan

- The two stub vitest suites (one per TS package) are the only tests this
  plan adds; they exist to prove the runner works so plan 002's real tests
  drop into a working harness.
- Verification: `pnpm -r test` → 2 suites, 2 tests, all green.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm install` exits 0 at the repo root
- [ ] `pnpm -r typecheck` exits 0
- [ ] `pnpm -r test` exits 0
- [ ] `pnpm --filter @rfid/field exec expo export --platform ios` exits 0
- [ ] `pnpm --filter @rfid/web build` exits 0
- [ ] `git diff --name-only` shows nothing under `apps/warehouse/`, `apps/cloud/`, `packages/contract/`, or `pyproject.toml`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `apps/field`, `apps/web`, `packages/domain`, or `packages/reader-protocol`
  already exist with content.
- `create-expo-app` or `create-next-app` fails due to network/registry access.
- Node < 20 is the only runtime available.
- Expo's generated template requires a config change not listed here to pass
  `expo export` — report the exact error instead of restructuring the app.

## Maintenance notes

- Plans 002–010 assume package names `@rfid/domain`, `@rfid/reader-protocol`,
  `@rfid/field`, `@rfid/web` and the scripts `typecheck`/`test` exactly as
  created here. Renaming anything breaks those plans.
- The Python and TS workspaces coexist at the root (uv + pnpm). Keep both
  lockfiles committed.
- `metro.config.js` monorepo wiring is load-bearing: if a later plan adds a
  package the field app imports, it resolves through `workspaceRoot` —
  no further Metro changes should be needed.
