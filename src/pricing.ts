/**
 * Tiny per-model price table for estimating per-project cost from the token
 * counts we read out of local transcripts. Mirrors the server's pricing table
 * (USD per 1M tokens, matched by model-name substring, ~2026-06). Kept small and
 * local so attribution can stay self-contained; unknown models price to 0.
 */
interface Price {
  in: number;
  out: number;
  cacheWrite: number;
  cacheRead: number;
}

const TABLE: Array<{ match: RegExp; price: Price }> = [
  { match: /opus/i, price: { in: 15, out: 75, cacheWrite: 18.75, cacheRead: 1.5 } },
  { match: /sonnet/i, price: { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 } },
  { match: /haiku/i, price: { in: 0.8, out: 4, cacheWrite: 1, cacheRead: 0.08 } },
  { match: /fable/i, price: { in: 15, out: 75, cacheWrite: 18.75, cacheRead: 1.5 } },
  { match: /gpt-4o|gpt-4\.1/i, price: { in: 2.5, out: 10, cacheWrite: 2.5, cacheRead: 1.25 } },
  { match: /gpt-5|o3|o4|codex/i, price: { in: 1.25, out: 10, cacheWrite: 1.25, cacheRead: 0.125 } },
  { match: /gemini.*flash/i, price: { in: 0.15, out: 0.6, cacheWrite: 0.15, cacheRead: 0.0375 } },
  { match: /gemini/i, price: { in: 1.25, out: 5, cacheWrite: 1.25, cacheRead: 0.31 } },
];

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/** Estimate USD cost for a model + token counts. Unknown models → 0. */
export function estimateCostUSD(model: string, t: TokenCounts): number {
  const row = TABLE.find((r) => r.match.test(model));
  if (!row) return 0;
  const p = row.price;
  const usd =
    (t.inputTokens * p.in +
      t.outputTokens * p.out +
      t.cacheCreationTokens * p.cacheWrite +
      t.cacheReadTokens * p.cacheRead) /
    1_000_000;
  return usd > 0 ? usd : 0;
}
