import { build } from "esbuild";

// The registry's adapter-utils 0.3.1 predates this host release despite the
// matching version. Bundle the pinned workspace code; never resolve it at runtime.
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: false,
  legalComments: "linked",
  banner: { js: 'import { createRequire as __kiroCreateRequire } from "node:module"; const require = __kiroCreateRequire(import.meta.url);' },
});
