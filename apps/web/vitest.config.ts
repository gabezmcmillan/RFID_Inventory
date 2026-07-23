import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Mirrors the `@/*` -> `./src/*` path alias from tsconfig.json so test files can
// import `@/lib/...` exactly like the app. Node environment (auth/libSQL/Better
// Auth are server-only).
export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
