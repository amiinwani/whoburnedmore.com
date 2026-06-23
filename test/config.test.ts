import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureAnonKey,
  loadConfig,
  recordSync,
  saveConfig,
} from "../src/config.js";

describe("config", () => {
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

  it("ignores legacy signed-in fields (no CLI login anymore)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wbm-test-"));
    // A config file left over from an old CLI that supported `login`.
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ token: "t0k3n", handle: "alice", anonKey: "a".repeat(64) }),
    );
    // Only the anon key survives — the device token is dropped, not honored.
    expect(loadConfig(dir)).toEqual({ anonKey: "a".repeat(64) });
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
