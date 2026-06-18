import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateCost, PRICING_AS_OF, priceFor } from "../src/pricing.js";

test("priceFor resolves models by longest substring match", () => {
  assert.equal(priceFor("claude-opus-4-7").output, 75);
  assert.equal(priceFor("claude-sonnet-4-5-20250929").output, 15);
  // tier-word family rows resolve both modern and legacy dated Claude ids
  assert.equal(priceFor("claude-haiku-4-5-20251001").output, 4);
  assert.equal(priceFor("claude-3-5-haiku-20241022").output, 4);
  assert.equal(priceFor("claude-3-opus-20240229").output, 75);
  assert.equal(priceFor("gpt-4o-2024-08-06").input, 2.5);
});

test("PRICING_AS_OF is a YYYY-MM string", () => {
  assert.match(PRICING_AS_OF, /^\d{4}-\d{2}$/);
});

test("longest-match prefers the more specific row (mini variants, dated families)", () => {
  // "gpt-4o-mini" must beat the generic "gpt-4o"
  assert.equal(priceFor("gpt-4o-mini-2024-07-18").input, 0.15);
  assert.notEqual(priceFor("gpt-4o-mini").input, priceFor("gpt-4o").input);
  // "gpt-5-mini" must beat "gpt-5"
  assert.equal(priceFor("gpt-5-mini").input, 0.25);
  assert.notEqual(priceFor("gpt-5-mini").input, priceFor("gpt-5-2026").input);
});

test("the newly added model families resolve to real rows", () => {
  assert.equal(priceFor("gpt-5-2026-01-01").input, 1.25);
  assert.equal(priceFor("o1-2024-12-17").input, 15);
  assert.equal(priceFor("o3-mini").input, 1.1);
  assert.equal(priceFor("gemini-1.5-pro").input, 1.25);
  assert.equal(priceFor("gemini-2.0-flash-001").input, 0.1);
  assert.equal(priceFor("gemini-3-pro-preview").input, 2);
});

test("priceFor falls back to a mid-tier default for unknown models (explicit)", () => {
  for (const id of ["some-future-model-v9", "", "llama-4-maverick", "mystery"]) {
    const p = priceFor(id);
    assert.equal(p.input, 3, `unknown model '${id}' should hit the default input rate`);
    assert.equal(p.output, 15, `unknown model '${id}' should hit the default output rate`);
  }
});

test("estimateCost sums input/output/cache at the model's rates", () => {
  // 1M input + 1M output on opus = 15 + 75 = $90
  const cost = estimateCost("claude-opus-4-7", {
    input: 1_000_000,
    output: 1_000_000,
    cacheWrite: 0,
    cacheRead: 0,
  });
  assert.equal(Math.round(cost), 90);
});

test("estimateCost prices cache reads far below input", () => {
  const read = estimateCost("claude-sonnet-4-5", {
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 1_000_000,
  });
  // sonnet cache-read is $0.30 / 1M
  assert.ok(read > 0.29 && read < 0.31, `expected ~0.30, got ${read}`);
});

test("estimateCost of nothing is zero", () => {
  assert.equal(
    estimateCost("claude-opus-4-7", { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }),
    0,
  );
});
