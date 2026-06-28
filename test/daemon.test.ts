import { describe, expect, it } from "vitest";
import { daemonLoop } from "../src/daemon.js";

describe("daemonLoop (foreground sync loop for VMs/containers)", () => {
  it("runs cycles until stopped, logging a heartbeat each time", async () => {
    const logs: string[] = [];
    let runs = 0;
    let waits = 0;
    const cycles = await daemonLoop({
      intervalMs: 1000,
      isStopped: () => runs >= 3,
      log: (l) => logs.push(l),
      wait: async () => {
        waits++;
      },
      runOnce: async () => {
        runs++;
      },
    });
    expect(cycles).toBe(3);
    expect(logs.filter((l) => l === "synced")).toHaveLength(3);
    // It must NOT sleep after the final cycle — the stop is detected before the
    // long wait, so a SIGTERM exits promptly instead of parking 15 min.
    expect(waits).toBe(2);
  });

  it("logs a failed cycle and keeps going (a blip never takes the daemon down)", async () => {
    const logs: string[] = [];
    let runs = 0;
    await daemonLoop({
      intervalMs: 1,
      isStopped: () => runs >= 2,
      log: (l) => logs.push(l),
      wait: async () => {},
      runOnce: async () => {
        runs++;
        if (runs === 1) throw new Error("network down");
      },
    });
    expect(logs[0]).toContain("sync failed: network down");
    expect(logs[0]).toContain("retrying next cycle");
    expect(logs).toContain("synced");
  });

  it("does nothing when stop is already signalled before the first cycle", async () => {
    let runs = 0;
    const cycles = await daemonLoop({
      intervalMs: 1,
      isStopped: () => true,
      log: () => {},
      wait: async () => {},
      runOnce: async () => {
        runs++;
      },
    });
    expect(cycles).toBe(0);
    expect(runs).toBe(0);
  });
});
