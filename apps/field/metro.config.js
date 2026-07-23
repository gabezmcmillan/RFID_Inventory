const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// The workspace packages are TypeScript ESM and import their own files with
// `.js` extensions (Node's convention). Metro resolves specifiers literally,
// so `./db.js` won't find `db.ts`. Strip a trailing `.js` from relative imports
// and delegate to Metro's default resolver (via `context.resolveRequest`), which
// then finds the `.ts` source through `sourceExts`.
//
// We also resolve the `@/*` tsconfig path alias (used by the vendored React
// Native Reusables components, e.g. `@/lib/utils`) to `./src/*`. Expo's metro
// config does not wire tsconfig `paths` into the resolver, so we do it here.
//
// NativeWind's `withNativeWind` wraps this resolver (it captures
// `config.resolver.resolveRequest` as `originalResolver` and calls it first,
// only intercepting the `global.css` input), so both behaviors are preserved
// for every other module.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  let resolved = moduleName;
  if (moduleName.startsWith("@/")) {
    resolved = path.resolve(projectRoot, "src", moduleName.slice(2));
  } else if (moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    resolved = moduleName.slice(0, -3);
  }
  return context.resolveRequest(context, resolved, platform);
};

module.exports = withNativeWind(config, { input: "./global.css", inlineRem: 16 });
