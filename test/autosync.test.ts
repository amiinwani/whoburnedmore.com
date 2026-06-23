import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildLaunchdPlist,
  cronSchedule,
  plistDrift,
  reconcileAction,
  resolveNodePath,
  rotateLogIfLarge,
  SYNC_INTERVAL_MINUTES,
  syncIntervalLabel,
} from "../src/autosync.js";

describe("buildLaunchdPlist", () => {
  it("produces a launchd plist that runs the sync command on an interval", () => {
    const plist = buildLaunchdPlist(
      "/usr/local/bin/node",
      "/path/to/cli.js",
      "/home/u/.config/whoburnedmore/sync.log",
    );
    expect(plist).toContain("com.whoburnedmore.sync");
    expect(plist).toContain("/usr/local/bin/node");
    expect(plist).toContain("/path/to/cli.js");
    expect(plist).toContain("<string>sync</string>");
    expect(plist).toContain("/home/u/.config/whoburnedmore/sync.log");
    expect(plist).not.toContain("/tmp/");
    expect(plist).toContain(
      `<integer>${SYNC_INTERVAL_MINUTES * 60}</integer>`,
    );
  });

  it("syncs at a sub-hour (15min) cadence by default", () => {
    // The cadence drop from hourly → 15min: the plist must carry 900s, not 3600s.
    expect(SYNC_INTERVAL_MINUTES).toBe(15);
    expect(syncIntervalLabel(15)).toBe("15m");
    expect(syncIntervalLabel(60)).toBe("1h");
    expect(syncIntervalLabel(120)).toBe("2h");
    // Linux cron uses the minute field for a sub-hour interval.
    expect(cronSchedule(15)).toBe("*/15 * * * *");
    expect(cronSchedule(60)).toBe("0 */1 * * *");
  });

  it("runs at load so a sync catches up after a reboot/login", () => {
    const plist = buildLaunchdPlist("/usr/local/bin/node", "/path/to/cli.js");
    // RunAtLoad must be true (not false) so a machine that missed a scheduled
    // tick while off/asleep syncs immediately on next login.
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).not.toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
    expect(plist).toContain("<key>ProcessType</key>");
  });
});

describe("resolveNodePath (stable node path)", () => {
  it("prefers a stable symlink over a version-pinned Cellar execPath", () => {
    const got = resolveNodePath({
      candidates: ["/opt/homebrew/bin/node"],
      check: (p) => p === "/opt/homebrew/bin/node",
      execPath: "/opt/homebrew/Cellar/node/25.9.0_2/bin/node",
    });
    expect(got).toBe("/opt/homebrew/bin/node");
    // The whole point: never bake the path that dies on `brew upgrade node`.
    expect(got).not.toContain("/Cellar/");
  });

  it("falls back to process execPath when no stable candidate qualifies", () => {
    const got = resolveNodePath({
      candidates: ["/opt/homebrew/bin/node", "/usr/local/bin/node"],
      check: () => false,
      execPath: "/some/runtime/node",
    });
    expect(got).toBe("/some/runtime/node");
  });
});

describe("plistDrift + reconcileAction (content drift reconciliation)", () => {
  const expected = buildLaunchdPlist("/usr/local/bin/node", "/cli.js");

  it("reports absent (→ install) when nothing is installed", () => {
    expect(plistDrift(null, expected)).toBe("absent");
    expect(reconcileAction("absent")).toBe("install");
  });

  it("reports drift (→ reinstall) for a stale hourly StartInterval vs a 15min source", () => {
    // The exact bug we are hardening against: an installed plist frozen at the old
    // 3600s (1h) cadence while the current source emits 900s (15min).
    const stale = expected.replace(
      "<integer>900</integer>",
      "<integer>3600</integer>",
    );
    expect(stale).not.toBe(expected);
    expect(plistDrift(stale, expected)).toBe("drift");
    expect(reconcileAction("drift")).toBe("install");
  });

  it("reports drift for a dead version-pinned Cellar node path", () => {
    const stale = expected.replace(
      "/usr/local/bin/node",
      "/opt/homebrew/Cellar/node/25.9.0_2/bin/node",
    );
    expect(plistDrift(stale, expected)).toBe("drift");
  });

  it("reports ok (→ noop) when the installed agent already matches", () => {
    expect(plistDrift(expected, expected)).toBe("ok");
    expect(reconcileAction("ok")).toBe("noop");
  });
});

describe("rotateLogIfLarge (log rotation)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wbm-log-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rolls the log to .1 once it exceeds the cap", () => {
    const log = join(dir, "sync.log");
    const big = "x".repeat(2048);
    writeFileSync(log, big);
    const rotated = rotateLogIfLarge(log, 1024);
    expect(rotated).toBe(true);
    expect(existsSync(log)).toBe(false); // fresh log starts on next write
    expect(readFileSync(`${log}.1`, "utf8")).toBe(big);
  });

  it("leaves a small log untouched", () => {
    const log = join(dir, "sync.log");
    writeFileSync(log, "tiny");
    expect(rotateLogIfLarge(log, 1024)).toBe(false);
    expect(readFileSync(log, "utf8")).toBe("tiny");
    expect(existsSync(`${log}.1`)).toBe(false);
  });

  it("is a no-op (no throw) when the log does not exist", () => {
    expect(rotateLogIfLarge(join(dir, "nope.log"), 1024)).toBe(false);
  });
});
