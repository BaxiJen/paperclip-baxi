import { build } from "esbuild";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// The registry's adapter-utils 0.3.1 predates this host release despite the
// matching version. Bundle the pinned workspace code; never resolve it at runtime.
const result = await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: false,
  metafile: true,
  legalComments: "linked",
  banner: { js: 'import { createRequire as __kiroCreateRequire } from "node:module"; const require = __kiroCreateRequire(import.meta.url);' },
});

// Preserve notices for every third-party module included in the distributable.
const notices = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.includes("node_modules/")) continue;
  let directory = path.dirname(path.resolve(input));
  while (directory !== path.dirname(directory)) {
    const manifest = path.join(directory, "package.json");
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      if (pkg.name) {
        const license = ["LICENSE", "LICENSE.txt", "LICENSE.md"].map((name) => path.join(directory, name)).find(existsSync);
        if (!license) throw new Error(`Missing bundled license for ${pkg.name}`);
        notices.set(pkg.name, `${pkg.name}@${pkg.version}\n\n${readFileSync(license, "utf8")}`);
        break;
      }
    }
    directory = path.dirname(directory);
  }
}
writeFileSync("dist/THIRD-PARTY-NOTICES.txt", [...notices.values()].join("\n\n---\n\n"));
