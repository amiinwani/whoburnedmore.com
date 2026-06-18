/**
 * The CLI version must be single-sourced from package.json — `--version` and the
 * published package can never drift. The bundle gets it via esbuild `define`
 * (__WBM_VERSION__); the unbundled dev path reads package.json directly. This test
 * checks that whatever path runs, the number printed matches package.json.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

test("package.json version is 1.1.0", () => {
  assert.equal(pkg.version, "1.1.0");
});

test("the real package version is NOT hard-coded anywhere in src/cli.ts", () => {
  const cli = readFileSync(join(ROOT, "src", "cli.ts"), "utf8");
  // The actual version must come from __WBM_VERSION__ / package.json — it must never
  // appear as a literal in the source (a "0.0.0" unreachable fallback is allowed).
  assert.equal(
    cli.includes(pkg.version),
    false,
    `src/cli.ts hard-codes the version literal '${pkg.version}' — it must be single-sourced`,
  );
  // And the version must be wired to the build-time define / package.json read.
  assert.match(cli, /__WBM_VERSION__/, "src/cli.ts must source the version from __WBM_VERSION__");
});

test("the built CLI's --version matches package.json", () => {
  const dist = join(ROOT, "dist", "cli.js");
  if (!existsSync(dist)) return; // skipped before a build; CI builds then tests
  const out = execFileSync("node", [dist, "--version"], { encoding: "utf8" }).trim();
  assert.equal(out, pkg.version);
});
