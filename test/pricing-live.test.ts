import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { estimateCostUSD, setLivePricing } from "../src/shared.js";
import { loadLivePricing } from "../src/pricing-live.js";

afterEach(() => setLivePricing(null));

const MTOK = {
  inputTokens: 1_000_000,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
};

async function tmpCachePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "wbm-pricing-")), "pricing-cache.json");
}

describe("loadLivePricing", () => {
  it("stays fully offline (baked snapshot) when WHOBURNEDMORE_PRICING_OFFLINE is set", async () => {
    const source = await loadLivePricing(
      { WHOBURNEDMORE_PRICING_OFFLINE: "1" } as NodeJS.ProcessEnv,
      Date.now,
      await tmpCachePath(),
    );
    expect(source).toBe("baked");
    expect(estimateCostUSD("claude-opus-4-8", MTOK)).toBeCloseTo(5, 6);
  });

  it("uses a fresh disk cache without touching the network", async () => {
    const path = await tmpCachePath();
    await writeFile(
      path,
      JSON.stringify({
        fetchedAt: Date.now(),
        table: { "claude-opus-4-8": [7, 30, 8, 0.7] },
      }),
    );
    // An unreachable URL proves no fetch happens on the fresh-cache path.
    const env = {
      WHOBURNEDMORE_PRICING_URL: "http://127.0.0.1:1/nope",
    } as NodeJS.ProcessEnv;
    const source = await loadLivePricing(env, Date.now, path);
    expect(source).toBe("cache");
    expect(estimateCostUSD("claude-opus-4-8", MTOK)).toBeCloseTo(7, 6);
  });

  it("falls back to a STALE cache when the fetch fails, and to baked with no cache", async () => {
    const path = await tmpCachePath();
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    await writeFile(
      path,
      JSON.stringify({
        fetchedAt: weekAgo,
        table: { "claude-opus-4-8": [6, 24, 7, 0.6] },
      }),
    );
    const env = {
      WHOBURNEDMORE_PRICING_URL: "http://127.0.0.1:1/nope",
    } as NodeJS.ProcessEnv;
    expect(await loadLivePricing(env, Date.now, path)).toBe("cache");
    expect(estimateCostUSD("claude-opus-4-8", MTOK)).toBeCloseTo(6, 6);

    setLivePricing(null);
    expect(await loadLivePricing(env, Date.now, await tmpCachePath())).toBe("baked");
  });

  it("fetches, installs, and caches live rates when the source responds", async () => {
    const path = await tmpCachePath();
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          "claude-opus-4-8": {
            mode: "chat",
            input_cost_per_token: 9e-6,
            output_cost_per_token: 4e-5,
            cache_read_input_token_cost: 9e-7,
          },
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    try {
      const env = {
        WHOBURNEDMORE_PRICING_URL: `http://127.0.0.1:${port}/prices.json`,
      } as NodeJS.ProcessEnv;
      expect(await loadLivePricing(env, Date.now, path)).toBe("live");
      expect(estimateCostUSD("claude-opus-4-8", MTOK)).toBeCloseTo(9, 6);
      const cached = JSON.parse(await readFile(path, "utf8"));
      expect(cached.table["claude-opus-4-8"][0]).toBe(9);
    } finally {
      server.close();
    }
  });
});
