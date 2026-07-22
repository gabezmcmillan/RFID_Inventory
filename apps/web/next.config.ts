import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@rfid/domain"],
  // `@tursodatabase/database` is a NAPI-RS native addon (a `.node` binding
  // loaded via optional platform deps). Turbopack can't bundle the native
  // loader, so keep it external and `require` it at runtime from node_modules,
  // where the platform binding resolves (the local-file dev path). The
  // serverless Turso driver is pure JS and bundles fine.
  serverExternalPackages: ["@tursodatabase/database"],
  experimental: {
    // The domain package is TypeScript ESM and imports its own files with
    // `.js` extensions (Node's convention); alias `.js` to `.ts`/`.tsx` for
    // any webpack-based path (turbopack resolves the now-extensionless imports
    // directly). Mirrors the field app's Metro `.js` strip.
    extensionAlias: {
      ".js": [".ts", ".tsx"],
    },
  },
};

export default nextConfig;
