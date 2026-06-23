import { describe, it, expect } from "vitest";
import { mapTokscaleDay } from "../src/tokscale.js";

describe("mapTokscaleDay", () => {
  it("maps a tokscale models report to cursor daily entries", () => {
    const entries = mapTokscaleDay("2026-06-10", {
      groupBy: "model",
      entries: [
        {
          client: "cursor",
          model: "claude-4.5-opus",
          input: 100,
          output: 20,
          reasoning: 5,
          cacheRead: 50,
          cacheWrite: 8,
          cost: 1.25,
        },
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      date: "2026-06-10",
      tool: "cursor",
      model: "claude-4.5-opus",
      inputTokens: 100,
      outputTokens: 25, // output + reasoning folded in
      cacheCreationTokens: 8, // cacheWrite -> cacheCreation
      cacheReadTokens: 50,
      costUSD: 1.25,
      origin: "cli",
      verified: false,
    });
  });

  it("skips zero-usage rows and defaults a missing model name", () => {
    const entries = mapTokscaleDay("2026-06-10", {
      entries: [
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        { input: 5, cost: 0 },
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].model).toBe("cursor");
    expect(entries[0].inputTokens).toBe(5);
  });

  it("returns [] for malformed input", () => {
    expect(mapTokscaleDay("2026-06-10", null)).toEqual([]);
    expect(mapTokscaleDay("2026-06-10", {})).toEqual([]);
    expect(mapTokscaleDay("2026-06-10", { entries: "nope" })).toEqual([]);
  });
});
