import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfigDir } from "./config.js";

/**
 * How often the background agent re-collects usage and submits it. Dropped from
 * 60min → 15min on 2026-06-21 so a dev's leaderboard rank, daily burn and streak
 * stay near-live without them re-running the command by hand. Submits are
 * idempotent server-side and a collect is light (~15s, background priority), so a
 * tighter cadence costs the machine almost nothing. Expressed in MINUTES because
 * launchd/cron/schtasks all need sub-hour granularity now.
 */
export const SYNC_INTERVAL_MINUTES = 15;
/** Human label for the interval, e.g. "15m" or "1h". Used in install messages. */
export function syncIntervalLabel(mins: number = SYNC_INTERVAL_MINUTES): string {
  return mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`;
}
const LABEL = "com.whoburnedmore.sync";

/**
 * Stable node locations to prefer over `process.execPath`. The launchd plist
 * captures the node binary path at install time; `process.execPath` on a Homebrew
 * machine is a *version-pinned* Cellar path
 * (`/opt/homebrew/Cellar/node/<ver>/bin/node`) that vanishes on the next
 * `brew upgrade node`, leaving the agent unable to launch — silently, with no log.
 * These symlinks survive node upgrades, so the agent keeps working.
 */
const STABLE_NODE_CANDIDATES = [
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
  "/usr/bin/node",
];

/**
 * Log inside the user's own config dir, not /tmp — a fixed /tmp path could
 * be pre-created as a symlink by another local user.
 */
export function syncLogPath(): string {
  return join(defaultConfigDir(), "sync.log");
}

export function buildLaunchdPlist(
  nodePath: string,
  scriptPath: string,
  logPath: string = syncLogPath(),
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
    <string>sync</string>
  </array>
  <key>StartInterval</key>
  <integer>${SYNC_INTERVAL_MINUTES * 60}</integer>
  <!-- Run once right after login/reboot so a machine that was off (or asleep)
       through a scheduled tick catches up immediately, then keeps to the
       interval. Submits are idempotent server-side, so an extra run is safe. -->
  <key>RunAtLoad</key>
  <true/>
  <!-- Be a good citizen: macOS schedules this with background priority. -->
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>
`;
}

function launchAgentPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function cliScriptPath(): string {
  return fileURLToPath(new URL("./index.js", import.meta.url));
}

/** True if `p` exists and runs `node -v` reporting major >= 20. */
function isUsableNode(p: string): boolean {
  if (!existsSync(p)) return false;
  const res = spawnSync(p, ["-v"], { encoding: "utf8" });
  if (res.status !== 0 || typeof res.stdout !== "string") return false;
  const major = Number(res.stdout.trim().replace(/^v/, "").split(".")[0]);
  return Number.isFinite(major) && major >= 20;
}

/**
 * Pick the node binary to bake into the background-sync schedule. Prefer a stable
 * symlink (see STABLE_NODE_CANDIDATES) that runs node >= 20, so the agent keeps
 * working across `brew upgrade node`; fall back to `process.execPath` only when no
 * stable candidate qualifies. `check`/`execPath` are injectable for tests.
 */
export function resolveNodePath(opts?: {
  candidates?: string[];
  check?: (p: string) => boolean;
  execPath?: string;
}): string {
  const candidates = opts?.candidates ?? STABLE_NODE_CANDIDATES;
  const check = opts?.check ?? isUsableNode;
  const execPath = opts?.execPath ?? process.execPath;
  for (const c of candidates) {
    if (check(c)) return c;
  }
  return execPath;
}

/** The exact launchd plist this machine *should* have right now (darwin). */
export function expectedDarwinPlist(): string {
  return buildLaunchdPlist(resolveNodePath(), cliScriptPath());
}

export type DriftState = "absent" | "drift" | "ok";

/**
 * Pure drift check: compare the installed agent content against what we'd write
 * now. `absent` (nothing installed) and `drift` (content differs — e.g. a stale
 * 3600s StartInterval against the current 900s source, or a dead Cellar node path) both mean the
 * agent must be (re)installed; `ok` means leave it alone.
 */
export function plistDrift(installed: string | null, expected: string): DriftState {
  if (installed === null) return "absent";
  return installed.trim() === expected.trim() ? "ok" : "drift";
}

/** Map a drift state to the action the reconcile gate takes. */
export function reconcileAction(state: DriftState): "install" | "noop" {
  return state === "ok" ? "noop" : "install";
}

/** Install the background sync for the current platform. Returns a human description. */
export function installAutoSync(): string {
  const os = platform();
  mkdirSync(defaultConfigDir(), { recursive: true });
  if (os === "darwin") {
    const plistPath = launchAgentPath();
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(plistPath, expectedDarwinPlist());
    spawnSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
    spawnSync("launchctl", ["load", plistPath], { stdio: "ignore" });
    return `launchd agent installed (${plistPath}), syncing every ${syncIntervalLabel()}`;
  }
  if (os === "linux") {
    const line = expectedLinuxCronLine();
    const current = spawnSync("crontab", ["-l"], { encoding: "utf8" });
    const existing = current.status === 0 ? current.stdout : "";
    // Drop any prior whoburnedmore line so an interval/path change actually
    // re-applies instead of leaving a stale entry behind (content reconciliation).
    const kept = existing
      .split("\n")
      .filter((l) => !l.includes("whoburnedmore"))
      .join("\n");
    const next = `${kept.trimEnd()}\n${line}\n`.replace(/^\n+/, "");
    const res = spawnSync("crontab", ["-"], { input: next });
    if (res.status !== 0) throw new Error("could not install crontab entry");
    return `cron entry installed, syncing every ${syncIntervalLabel()}`;
  }
  if (os === "win32") {
    const res = spawnSync("schtasks", [
      "/Create", "/F",
      "/SC", "MINUTE",
      "/MO", String(SYNC_INTERVAL_MINUTES),
      "/TN", "whoburnedmore-sync",
      "/TR", `"${resolveNodePath()}" "${cliScriptPath()}" sync`,
    ]);
    if (res.status !== 0) throw new Error("could not create scheduled task");
    return `scheduled task installed, syncing every ${syncIntervalLabel()}`;
  }
  throw new Error(`auto-sync is not supported on ${os}`);
}

/** Cron schedule expression for the sync interval (sub-hour → minute field). */
export function cronSchedule(mins: number = SYNC_INTERVAL_MINUTES): string {
  return mins % 60 === 0 ? `0 */${mins / 60} * * *` : `*/${mins} * * * *`;
}

/** The exact crontab line this machine should have right now (linux). */
export function expectedLinuxCronLine(): string {
  return `${cronSchedule()} "${resolveNodePath()}" "${cliScriptPath()}" sync >"${syncLogPath()}" 2>&1`;
}

export function uninstallAutoSync(): string {
  const os = platform();
  if (os === "darwin") {
    const plistPath = launchAgentPath();
    if (existsSync(plistPath)) {
      spawnSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
      rmSync(plistPath, { force: true });
    }
    return "launchd agent removed";
  }
  if (os === "linux") {
    const current = spawnSync("crontab", ["-l"], { encoding: "utf8" });
    if (current.status === 0 && current.stdout.includes("whoburnedmore")) {
      const next = current.stdout
        .split("\n")
        .filter((l) => !l.includes("whoburnedmore"))
        .join("\n");
      spawnSync("crontab", ["-"], { input: next });
    }
    return "cron entry removed";
  }
  if (os === "win32") {
    spawnSync("schtasks", ["/Delete", "/F", "/TN", "whoburnedmore-sync"]);
    return "scheduled task removed";
  }
  return "nothing to remove";
}

export function autoSyncInstalled(): boolean {
  if (platform() === "darwin") return existsSync(launchAgentPath());
  if (platform() === "linux") {
    const current = spawnSync("crontab", ["-l"], { encoding: "utf8" });
    return current.status === 0 && current.stdout.includes("whoburnedmore");
  }
  if (platform() === "win32") {
    const res = spawnSync("schtasks", ["/Query", "/TN", "whoburnedmore-sync"], {
      stdio: "ignore",
    });
    return res.status === 0;
  }
  return false;
}

/** Read the currently-installed agent config as a string, or null if absent. */
function readInstalledAgent(): string | null {
  if (platform() === "darwin") {
    const p = launchAgentPath();
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }
  if (platform() === "linux") {
    const current = spawnSync("crontab", ["-l"], { encoding: "utf8" });
    if (current.status !== 0) return null;
    const line = current.stdout
      .split("\n")
      .find((l) => l.includes("whoburnedmore"));
    return line ?? null;
  }
  return null;
}

/** What the installed agent *should* be on this platform, for drift comparison. */
function expectedAgent(): string | null {
  if (platform() === "darwin") return expectedDarwinPlist();
  if (platform() === "linux") return expectedLinuxCronLine();
  return null;
}

/** Current drift state of the background agent (darwin/linux). */
export function autoSyncDrift(): DriftState {
  const expected = expectedAgent();
  // Platforms we can't read back (win32) fall back to existence-only.
  if (expected === null) return autoSyncInstalled() ? "ok" : "absent";
  return plistDrift(readInstalledAgent(), expected);
}

/**
 * Heal-on-run: reinstall the background agent when it's absent OR has drifted
 * (stale interval, dead node path, changed script path), and leave it alone when
 * it already matches. Returns what it did. Callers wrap this best-effort — a
 * reconcile failure must never fail a submit.
 */
export function reconcileAutoSync(): "installed" | "reinstalled" | "noop" {
  const state = autoSyncDrift();
  if (reconcileAction(state) === "noop") return "noop";
  installAutoSync();
  return state === "absent" ? "installed" : "reinstalled";
}

/**
 * Keep launchd's append-only StandardOutPath from growing without bound: once the
 * log passes `capBytes`, roll it to `<path>.1` (overwriting any older roll) so a
 * fresh, small log starts on the next write. Best-effort and silent on error.
 */
export function rotateLogIfLarge(
  path: string = syncLogPath(),
  capBytes = 256 * 1024,
): boolean {
  try {
    if (!existsSync(path)) return false;
    if (statSync(path).size <= capBytes) return false;
    renameSync(path, `${path}.1`);
    return true;
  } catch {
    return false;
  }
}

/** True if the launchd/cron/schtasks job is currently loaded with the scheduler. */
export function autoSyncLoaded(): boolean {
  if (platform() === "darwin") {
    const res = spawnSync("launchctl", ["list"], { encoding: "utf8" });
    return res.status === 0 && res.stdout.includes(LABEL);
  }
  // On linux/win, "installed" == "loaded" (cron/schtasks have no separate state).
  return autoSyncInstalled();
}
