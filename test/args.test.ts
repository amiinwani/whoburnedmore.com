import assert from "node:assert/strict";
import { test } from "node:test";
import { ArgError, parseArgs } from "../src/cli.js";

test("parseArgs reads the simple boolean flags", () => {
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["--version"]).version, true);
  assert.equal(parseArgs(["--json"]).json, true);
  assert.equal(parseArgs(["--by-day"]).byDay, true);
});

test("parseArgs handles -h / -v aliases", () => {
  assert.equal(parseArgs(["-h"]).help, true);
  assert.equal(parseArgs(["-v"]).version, true);
});

test("parseArgs throws ArgError on an unknown flag", () => {
  assert.throws(() => parseArgs(["--nope"]), (e: unknown) => {
    assert.ok(e instanceof ArgError);
    assert.match((e as ArgError).message, /unknown option '--nope'/);
    return true;
  });
});

test("parseArgs throws on a bare positional argument", () => {
  assert.throws(() => parseArgs(["wat"]), ArgError);
});

test("parseArgs rejects a non-numeric --since (no silent all-time)", () => {
  assert.throws(() => parseArgs(["--since", "abc"]), (e: unknown) => {
    assert.ok(e instanceof ArgError);
    assert.match((e as ArgError).message, /positive number/);
    return true;
  });
});

test("parseArgs rejects --since 0 and negatives", () => {
  assert.throws(() => parseArgs(["--since", "0"]), ArgError);
  assert.throws(() => parseArgs(["--since", "-5"]), ArgError);
});

test("parseArgs accepts a valid --since", () => {
  assert.equal(parseArgs(["--since", "30"]).sinceDays, 30);
});

test("parseArgs errors when a value-taking flag has no value", () => {
  assert.throws(() => parseArgs(["--since"]), ArgError);
  assert.throws(() => parseArgs(["--dir"]), ArgError);
  // a flag followed by another flag is also "no value"
  assert.throws(() => parseArgs(["--dir", "--json"]), ArgError);
});

test("--html takes an OPTIONAL path", () => {
  const noPath = parseArgs(["--html"]);
  assert.equal(noPath.html, true);
  assert.equal(noPath.htmlPath, undefined);

  const withPath = parseArgs(["--html", "out.html"]);
  assert.equal(withPath.html, true);
  assert.equal(withPath.htmlPath, "out.html");

  // a following flag is not swallowed as the path
  const thenFlag = parseArgs(["--html", "--json"]);
  assert.equal(thenFlag.html, true);
  assert.equal(thenFlag.htmlPath, undefined);
  assert.equal(thenFlag.json, true);
});

test("--agent only accepts known agents", () => {
  assert.equal(parseArgs(["--agent", "codex"]).agent, "codex");
  assert.equal(parseArgs(["--agent", "claude-code"]).agent, "claude-code");
  assert.throws(() => parseArgs(["--agent", "cursor"]), ArgError);
});

test("parseArgs is order-independent and combines flags", () => {
  const a = parseArgs(["--since", "7", "--json", "--dir", "/tmp/x", "--by-day"]);
  assert.equal(a.sinceDays, 7);
  assert.equal(a.json, true);
  assert.equal(a.dir, "/tmp/x");
  assert.equal(a.byDay, true);

  // reordered -> same result
  const b = parseArgs(["--by-day", "--dir", "/tmp/x", "--json", "--since", "7"]);
  assert.deepEqual(b, a);
});
