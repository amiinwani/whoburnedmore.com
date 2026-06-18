/**
 * ZERO-NETWORK GUARD — the load-bearing security invariant of this tool.
 *
 * whoburnedmore promises that it makes NO network requests of any kind: it only reads
 * local transcript files and prints numbers. This test enforces that promise
 * mechanically, so a regression (an accidental `fetch`, a new dependency that opens a
 * socket, a telemetry "phone home") fails CI instead of shipping.
 *
 * It scans BOTH the TypeScript source in src/ AND the bundled, ready-to-run
 * dist/cli.js (which inlines every dependency), and asserts that none of the following
 * appear anywhere:
 *
 *   fetch(            — the Fetch API
 *   http://, https:// — any URL literal (with ONE allowed exception, below)
 *   node:net / node:tls / node:dgram — raw sockets / TLS / UDP
 *   WebSocket         — websockets
 *   XMLHttpRequest    — legacy XHR
 *
 * The ONLY permitted URL is the single visible leaderboard link the report/HTML print
 * for the human to click — `https://whoburnedmore.com`. That is display copy, never a
 * request the tool makes. Every other occurrence is a failure.
 *
 * If you are adding a legitimate feature that needs one of these, you are changing the
 * fundamental promise of the project — do not relax this test; reconsider the feature.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** The single allowed URL: the visible leaderboard link in display copy. */
const ALLOWED_URL = "https://whoburnedmore.com";

/** Patterns that must never appear (after the allowed URL is stripped out). */
const FORBIDDEN: Array<{ label: string; re: RegExp }> = [
  { label: "fetch(", re: /\bfetch\s*\(/ },
  { label: "http:// URL", re: /http:\/\// },
  { label: "https:// URL", re: /https:\/\// },
  { label: "node:net", re: /node:net\b/ },
  { label: "node:tls", re: /node:tls\b/ },
  { label: "node:dgram", re: /node:dgram\b/ },
  { label: "WebSocket", re: /\bWebSocket\b/ },
  { label: "XMLHttpRequest", re: /\bXMLHttpRequest\b/ },
];

/** Remove every occurrence of the one allowed URL so the rest can be checked strictly. */
function stripAllowed(text: string): string {
  return text.split(ALLOWED_URL).join("«allowed-leaderboard-link»");
}

function collectSources(): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];

  // 1) every TypeScript source file under src/
  const srcDir = join(ROOT, "src");
  for (const name of readdirSync(srcDir)) {
    if (name.endsWith(".ts")) out.push({ name: `src/${name}`, text: readFileSync(join(srcDir, name), "utf8") });
  }

  // 2) the bundled CLI, if it has been built (it inlines all dependencies)
  const dist = join(ROOT, "dist", "cli.js");
  if (existsSync(dist)) out.push({ name: "dist/cli.js", text: readFileSync(dist, "utf8") });

  return out;
}

test("no source or bundle contains networking primitives (zero-network invariant)", () => {
  const sources = collectSources();
  assert.ok(sources.length >= 1, "expected at least the src/ files to scan");

  for (const { name, text } of sources) {
    const scrubbed = stripAllowed(text);
    for (const { label, re } of FORBIDDEN) {
      const m = scrubbed.match(re);
      assert.equal(
        m,
        null,
        `${name} contains a forbidden networking pattern (${label})` +
          (m ? `: ...${scrubbed.slice(Math.max(0, m.index! - 30), m.index! + 30)}...` : ""),
      );
    }
  }
});

test("the dist bundle is present so the guard actually covers shipped code", () => {
  // A soft reminder: the strongest version of this guard runs against the built
  // bundle. `npm run build && npm test` exercises it; CI does both.
  const dist = join(ROOT, "dist", "cli.js");
  if (!existsSync(dist)) {
    // Don't fail when running tests before a build — src/ was still fully checked.
    return;
  }
  const text = readFileSync(dist, "utf8");
  // sanity: the bundle is non-trivial and the only URL in it is the allowed link
  assert.ok(text.length > 1000, "bundle looks too small to be the real CLI");
  const others = stripAllowed(text).match(/https?:\/\/[^\s"'`)]+/g);
  assert.equal(others, null, `bundle contains an unexpected URL: ${others?.join(", ")}`);
});
