import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Mirrors the `@/*` -> `./src/*` path alias from tsconfig.json so test files can
// import `@/...` exactly like the app. Node environment: the pure sync modules
// (coordinator, backoff, BOL queue, schema version) inject their own clocks /
// engines and never touch React Native, so they run under node without a device.
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
