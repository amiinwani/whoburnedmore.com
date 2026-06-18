// Dev-only build script: bundles src/cli.ts into the single dist/cli.js with
// esbuild, injecting the package.json version as __WBM_VERSION__ so --version and
// the published package can never drift. Not shipped (devDependency esbuild only).
import { build } from "esbuild";
import { chmodSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/cli.js",
  banner: { js: "#!/usr/bin/env node" },
  define: { __WBM_VERSION__: JSON.stringify(pkg.version) },
});

chmodSync("dist/cli.js", 0o755);
console.log(`built dist/cli.js (v${pkg.version})`);
