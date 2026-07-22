import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit config. `generate` reads the Drizzle schema from `src/schema.ts`
 * and writes SQL migration files to `drizzle/`. The Turso migrator
 * (`src/migrate.ts`) applies those files at runtime.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./drizzle",
});
