import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CliConfig {
  /** Secret that owns this machine's dashboard. The CLI's only identity — the
   *  web is the source of truth for accounts (claim this dashboard there). */
  anonKey?: string;
  /** Epoch ms of the last successful submit. Powers `status` freshness/staleness
   *  reporting — a truer signal than the log file's mtime, which moves on any
   *  write (including errors). */
  lastSyncAt?: number;
}

export function defaultConfigDir(): string {
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
    if (typeof parsed.lastSyncAt === "number" && Number.isFinite(parsed.lastSyncAt))
      config.lastSyncAt = parsed.lastSyncAt;
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
  writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  // writeFileSync's `mode` only applies when the file is freshly created; if the
  // config already existed with looser permissions it would keep them. This file
  // holds the anonKey secret, so re-assert owner-only (0600) on every save.
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best-effort: some filesystems (e.g. Windows) don't support POSIX modes */
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
