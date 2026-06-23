import { describe, expect, it, vi } from "vitest";
import type { SubmitPayload } from "../src/shared.js";
import { publishLocal, type PublishDeps } from "../src/publish.js";

const payload: SubmitPayload = {
  cliVersion: "0.1.0",
  entries: [
    {
      date: "2026-06-13",
      tool: "claude",
      model: "claude-opus-4-7",
      inputTokens: 1,
      outputTokens: 1,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUSD: 0,
      origin: "cli",
      verified: false,
    },
  ],
};

function deps(accept: boolean): PublishDeps & {
  anonSubmit: ReturnType<typeof vi.fn>;
  openBrowser: ReturnType<typeof vi.fn>;
} {
  return {
    confirm: vi.fn(async () => accept),
    ensureAnonKey: vi.fn(() => "a".repeat(32)),
    anonSubmit: vi.fn(async () => ({
      ok: true as const,
      upserted: 1,
      totalTokens: 2,
      totalCostUSD: 0,
      slug: "s-l-u-g",
      dashboardUrl: "http://host/d/s-l-u-g",
    })),
    openBrowser: vi.fn(),
    log: vi.fn(),
  };
}

describe("publishLocal", () => {
  it("submits anonymously and opens the dashboard with the claim handoff on accept", async () => {
    const d = deps(true);
    const published = await publishLocal(payload, d);
    expect(published).toBe(true);
    expect(d.anonSubmit).toHaveBeenCalledOnce();
    expect(d.openBrowser).toHaveBeenCalledWith(
      expect.stringContaining("#k="),
    );
  });

  it("stays offline on decline — never submits or opens a browser", async () => {
    const d = deps(false);
    const published = await publishLocal(payload, d);
    expect(published).toBe(false);
    expect(d.anonSubmit).not.toHaveBeenCalled();
    expect(d.openBrowser).not.toHaveBeenCalled();
  });
});
