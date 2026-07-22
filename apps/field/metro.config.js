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

// The workspace packages are TypeScript ESM and import their own files with
// `.js` extensions (Node's convention). Metro resolves specifiers literally,
// so `./db.js` won't find `db.ts`. Strip a trailing `.js` from relative imports
// and delegate to Metro's default resolver (via `context.resolveRequest`), which
// then finds the `.ts` source through `sourceExts`.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const stripped =
    moduleName.startsWith(".") && moduleName.endsWith(".js")
      ? moduleName.slice(0, -3)
      : moduleName;
  return context.resolveRequest(context, stripped, platform);
};

module.exports = config;
