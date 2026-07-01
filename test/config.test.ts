import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearAuth,
  defaultConfigDir,
  ensureAnonKey,
  loadConfig,
  recordSync,
  recordLaunchNotificationDelivered,
  saveAuth,
  saveConfig,
} from "../src/config.js";

describe("config", () => {
  it("allows a disposable config directory override for local testing", () => {
    const dir = mkdtempSync(join(tmpdir(), "wbm-test-"));
    const prev = process.env.WHOBURNEDMORE_CONFIG_DIR;
    process.env.WHOBURNEDMORE_CONFIG_DIR = dir;
    try {
      expect(defaultConfigDir()).toBe(dir);
      const first = ensureAnonKey();
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      expect(loadConfig()?.anonKey).toBe(first);
    } finally {
      if (prev === undefined) delete process.env.WHOBURNEDMORE_CONFIG_DIR;
      else process.env.WHOBURNEDMORE_CONFIG_DIR = prev;
    }
  });

  it("round-trips the anon key", () => {
    const dir = mkdtempSync(join(tmpdir(), "wbm-test-"));
    expect(loadConfig(dir)).toBeNull();
    saveConfig(dir, { anonKey: "k".repeat(64) });
    expect(loadConfig(dir)).toEqual({ anonKey: "k".repeat(64) });
  });

  it("returns null for corrupt config files", () => {
    const dir = mkdtempSync(join(tmpdir(), "wbm-test-"));
    saveConfig(dir, { anonKey: "x".repeat(64) });
    writeFileSync(join(dir, "config.json"), "{not json");
    expect(loadConfig(dir)).toBeNull();
  });

  it.skipIf(platform() === "win32")(
    "re-tightens an existing loose-permission config to 0600 (anonKey is secret)",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "wbm-test-"));
      const file = join(dir, "config.json");
      // Simulate a config left world-readable by an older CLI or manual edit.
      writeFileSync(file, JSON.stringify({ anonKey: "a".repeat(64) }), {
        mode: 0o644,
      });
      expect(statSync(file).mode & 0o777).toBe(0o644);
      // Saving over it must restore owner-only perms, not inherit the loose ones.
      saveConfig(dir, { anonKey: "b".repeat(64) });
      expect(statSync(file).mode & 0o777).toBe(0o600);
    },
  );

  it("round-trips lastSyncAt alongside the anon key", () => {
    const dir = mkdtempSync(join(tmpdir(), "wbm-test-"));
    saveConfig(dir, { anonKey: "k".repeat(64), lastSyncAt: 1700000000000 });
    expect(loadConfig(dir)).toEqual({
      anonKey: "k".repeat(64),
      lastSyncAt: 1700000000000,
    });
  });

  it("ignores a non-numeric lastSyncAt (garbage in config)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wbm-test-"));
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ anonKey: "a".repeat(64), lastSyncAt: "nope" }),
    );
    expect(loadConfig(dir)).toEqual({ anonKey: "a".repeat(64) });
  });

  it("recordSync stamps lastSyncAt while preserving the anon key", () => {
    const dir = mkdtempSync(join(tmpdir(), "wbm-test-"));
    saveConfig(dir, { anonKey: "k".repeat(64) });
    recordSync(dir, 1234567890);
    expect(loadConfig(dir)).toEqual({
      anonKey: "k".repeat(64),
      lastSyncAt: 1234567890,
    });
  });

  it("records launch notification delivery while preserving sync state", () => {
    const dir = mkdtempSync(join(tmpdir(), "wbm-test-"));
    saveConfig(dir, { anonKey: "k".repeat(64), lastSyncAt: 123 });
    recordLaunchNotificationDelivered(dir, 456);
    expect(loadConfig(dir)).toEqual({
      anonKey: "k".repeat(64),
      lastSyncAt: 123,
      launchNotificationDeliveredAt: 456,
    });
  });

  it("ignores a legacy `token` field but honors the new cliToken + handle", () => {
    const dir = mkdtempSync(join(tmpdir(), "wbm-test-"));
    // A config file mixing an OLD-style `token` field (the pre-rename login token)
    // with the current `cliToken`/`handle` sign-in fields.
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        token: "legacy-ignored",
        cliToken: "jwt.abc.def",
        handle: "alice",
        anonKey: "a".repeat(64),
      }),
    );
    // The legacy `token` is dropped (we read `cliToken` now); the sign-in fields load.
    expect(loadConfig(dir)).toEqual({
      cliToken: "jwt.abc.def",
      handle: "alice",
      anonKey: "a".repeat(64),
    });
  });

  it("saveAuth persists the CLI token + handle, preserving other fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "wbm-test-"));
    saveConfig(dir, { anonKey: "k".repeat(64), lastSyncAt: 99 });
    saveAuth(dir, { cliToken: "tok-123", handle: "bob" });
    expect(loadConfig(dir)).toEqual({
      anonKey: "k".repeat(64),
      lastSyncAt: 99,
      cliToken: "tok-123",
      handle: "bob",
    });
  });

  it("clearAuth drops the token + handle, preserving everything else", () => {
    const dir = mkdtempSync(join(tmpdir(), "wbm-test-"));
    saveConfig(dir, {
      anonKey: "k".repeat(64),
      cliToken: "tok-123",
      handle: "bob",
      lastSyncAt: 99,
    });
    clearAuth(dir);
    expect(loadConfig(dir)).toEqual({ anonKey: "k".repeat(64), lastSyncAt: 99 });
  });
});

describe("ensureAnonKey", () => {
  it("generates a key on first use and returns the same one thereafter", () => {
    const dir = mkdtempSync(join(tmpdir(), "wbm-test-"));
    const first = ensureAnonKey(dir);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(ensureAnonKey(dir)).toBe(first);
    expect(loadConfig(dir)?.anonKey).toBe(first);
  });
});
