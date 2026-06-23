import { afterEach, describe, expect, it, vi } from "vitest";
import {
  anonRemove,
  anonSubmit,
  anonVisibility,
  boardClaimUrl,
  claimUrl,
} from "../src/api.js";

describe("claimUrl", () => {
  it("appends the anon key as a URL fragment (the claim handoff)", () => {
    expect(claimUrl("https://whoburnedmore.com/d/abc-def", "secretkey123")).toBe(
      "https://whoburnedmore.com/d/abc-def#k=secretkey123",
    );
  });

  it("URL-encodes the key", () => {
    expect(claimUrl("http://x/d/s", "a b/c")).toBe("http://x/d/s#k=a%20b%2Fc");
  });
});

describe("boardClaimUrl", () => {
  it("carries the claim key AND the dashboard slug as fragment params", () => {
    expect(
      boardClaimUrl(
        "https://whoburnedmore.com/boards/AB12",
        "molten-goblin-482",
        "secretkey123",
      ),
    ).toBe(
      "https://whoburnedmore.com/boards/AB12#k=secretkey123&u=molten-goblin-482",
    );
  });

  it("URL-encodes both the key and the slug", () => {
    expect(boardClaimUrl("http://x/boards/c", "a b", "a b/c")).toBe(
      "http://x/boards/c#k=a%20b%2Fc&u=a%20b",
    );
  });
});

describe("anon visibility + remove", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs to /v1/anon/visibility with the key + listed flag", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await anonVisibility("k".repeat(32), false);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toMatch(/\/v1\/anon\/visibility$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      anonKey: "k".repeat(32),
      listed: false,
    });
  });

  it("DELETEs /v1/anon with the key", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await anonRemove("k".repeat(32));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toMatch(/\/v1\/anon$/);
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body as string)).toEqual({ anonKey: "k".repeat(32) });
  });

  it("throws with the server error on non-200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "nope" }), { status: 404 }),
      ),
    );
    await expect(anonRemove("k".repeat(32))).rejects.toThrow("nope");
  });
});

describe("network resilience", () => {
  afterEach(() => vi.unstubAllGlobals());

  const payload = { cliVersion: "0.3.0", entries: [] };

  it("does not crash on a non-JSON 502 (Azure cold start / gateway)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>502 Bad Gateway</html>", { status: 502 }),
      ),
    );
    // Must throw a clean message, not a raw JSON 'Unexpected token <' parse error.
    await expect(anonSubmit("k".repeat(32), payload)).rejects.toThrow(
      /temporarily unavailable/,
    );
  });

  it("throws a friendly message when the network is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(anonSubmit("k".repeat(32), payload)).rejects.toThrow(
      /couldn't reach the leaderboard server/,
    );
  });
});
