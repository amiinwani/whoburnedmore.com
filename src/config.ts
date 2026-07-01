import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CliConfig {
  /** Secret that owns this machine's LEGACY anonymous dashboard / server-install
   *  device binding. The new CLI signs in instead (see `cliToken`); this is kept
   *  only for already-linked headless servers and pre-sign-in installs. */
  anonKey?: string;
  /** Server-issued CLI bearer token (a `typ:"cli"` JWT) obtained from the device
   *  sign-in flow. The account credential the authenticated submit path
   *  (`/v1/submit`) presents — this is what makes a run a SIGNED-IN run, so a
   *  fabricated POST can no longer land usage on an account. Owner-only on disk. */
  cliToken?: string;
  /** The signed-in handle `cliToken` belongs to, for friendly terminal messaging. */
  handle?: string;
  /** Epoch ms of the last successful submit. Powers `status` freshness/staleness
   *  reporting — a truer signal than the log file's mtime, which moves on any
   *  write (including errors). */
  lastSyncAt?: number;
  /** Epoch ms after the one-time launch-open desktop notification was delivered. */
  launchNotificationDeliveredAt?: number;
}

export function defaultConfigDir(): string {
  const override = process.env.WHOBURNEDMORE_CONFIG_DIR?.trim();
  if (override) return override;
  return join(homedir(), ".config", "whoburnedmore");
}

export function loadConfig(dir: string = defaultConfigDir()): CliConfig | null {
  const file = join(dir, "config.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    const config: CliConfig = {};
    if (typeof parsed.anonKey === "string") config.anonKey = parsed.anonKey;
    if (typeof parsed.cliToken === "string") config.cliToken = parsed.cliToken;
    if (typeof parsed.handle === "string") config.handle = parsed.handle;
    if (typeof parsed.lastSyncAt === "number" && Number.isFinite(parsed.lastSyncAt))
      config.lastSyncAt = parsed.lastSyncAt;
    if (
      typeof parsed.launchNotificationDeliveredAt === "number" &&
      Number.isFinite(parsed.launchNotificationDeliveredAt)
    ) {
      config.launchNotificationDeliveredAt = parsed.launchNotificationDeliveredAt;
    }
    return Object.keys(config).length > 0 ? config : null;
  } catch {
    return null;
  }
}

export function saveConfig(
  dir: string = defaultConfigDir(),
  config: CliConfig = {},
): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "config.json");
  // Write owner-only to a fresh temp file, then atomically rename it over the
  // target. This file holds the anonKey secret, so writing in place would (a) leave
  // a brief world-readable window when the config already existed with looser perms
  // — writeFileSync's `mode` only applies to a freshly-created inode — and (b) follow
  // a symlink an attacker may have planted at config.json. The fresh-inode + rename
  // avoids both: the secret only ever exists at 0600, and the rename can't traverse a
  // symlink at the destination.
  const tmp = join(dir, `config.json.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      /* best-effort: some filesystems (e.g. Windows) don't support POSIX modes */
    }
    renameSync(tmp, file);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

/**
 * Return this machine's anonymous-dashboard secret, generating and persisting
 * one on first use. Preserves any existing signed-in token/handle in the file.
 */
export function ensureAnonKey(dir: string = defaultConfigDir()): string {
  const config = loadConfig(dir) ?? {};
  if (config.anonKey) return config.anonKey;
  const anonKey = randomBytes(32).toString("hex");
  saveConfig(dir, { ...config, anonKey });
  return anonKey;
}

/**
 * Stamp the time of a successful submit, preserving the rest of the config
 * (notably `anonKey`). `status` reads this to report freshness/staleness.
 */
export function recordSync(
  dir: string = defaultConfigDir(),
  when: number = Date.now(),
): void {
  const config = loadConfig(dir) ?? {};
  saveConfig(dir, { ...config, lastSyncAt: when });
}

export function recordLaunchNotificationDelivered(
  dir: string = defaultConfigDir(),
  when: number = Date.now(),
): void {
  const config = loadConfig(dir) ?? {};
  saveConfig(dir, { ...config, launchNotificationDeliveredAt: when });
}

/**
 * Persist the signed-in CLI bearer token (and handle), preserving the rest of
 * the config. Written owner-only via saveConfig's atomic 0600 rename — this is a
 * real account credential, so it must never land in a world-readable file.
 */
export function saveAuth(
  dir: string = defaultConfigDir(),
  auth: { cliToken: string; handle?: string } = { cliToken: "" },
): void {
  const config = loadConfig(dir) ?? {};
  saveConfig(dir, { ...config, cliToken: auth.cliToken, handle: auth.handle });
}

/**
 * Drop the stored CLI token + handle (e.g. after the server rejects it as
 * expired/invalid), preserving everything else so the machine can re-sign-in.
 */
export function clearAuth(dir: string = defaultConfigDir()): void {
  const config = loadConfig(dir);
  if (!config?.cliToken && !config?.handle) return;
  const { cliToken: _t, handle: _h, ...rest } = config;
  saveConfig(dir, rest);
}
