/**
 * Public, approximate per-model pricing (USD per 1,000,000 tokens).
 *
 * These are list prices published by the model vendors and are used only to turn a
 * local token count into a rough dollar estimate. They are not billing-accurate —
 * subscription plans, discounts and price changes all move the real number — so the
 * CLI always labels cost as an estimate. Everything here is public information.
 */

/** Month these list prices were last reviewed. Surfaced in the report + HTML footer. */
export const PRICING_AS_OF = "2026-06";

export interface ModelPrice {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M tokens written to the prompt cache (defaults to 1.25× input). */
  cacheWrite?: number;
  /** USD per 1M tokens read from the prompt cache (defaults to 0.1× input). */
  cacheRead?: number;
}

/**
 * Matched by substring against the model id (longest match wins), so "claude-opus-4-7"
 * and "claude-opus-4-1-20250805" both resolve to the opus row. Add your own rows freely.
 *
 * Generic family rows (e.g. "claude-opus", "gpt-5", "gemini-2.5") are intentionally
 * forward-compatible: a future dated model id still resolves to a sensible row.
 */
const TABLE: Record<string, ModelPrice> = {
  // Anthropic Claude — keyed on the tier word so BOTH "claude-opus-4-1" and the older
  // "claude-3-opus" / "claude-3-5-haiku" ids resolve without per-version duplicate rows.
  opus: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },

  // OpenAI GPT / o-series.
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  "gpt-5": { input: 1.25, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "o4-mini": { input: 1.1, output: 4.4 },
  "o3-mini": { input: 1.1, output: 4.4 },
  "o3": { input: 2, output: 8 },
  "o1-mini": { input: 1.1, output: 4.4 },
  "o1": { input: 15, output: 60 },

  // Google Gemini families (1.5 / 2.0 / 3).
  "gemini-1.5-pro": { input: 1.25, output: 5 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-3-pro": { input: 2, output: 12 },
  "gemini-3-flash": { input: 0.4, output: 3 },
};

/** Fallback when a model id matches nothing in the table (mid-tier assumption). */
const DEFAULT_PRICE: ModelPrice = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };

/**
 * Resolve the price row for a model id by longest substring match.
 * Unknown ids fall back to {@link DEFAULT_PRICE} — see the unit tests.
 */
export function priceFor(model: string): ModelPrice {
  const id = model.toLowerCase();
  let best: { key: string; price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(TABLE)) {
    if (id.includes(key) && (!best || key.length > best.key.length)) {
      best = { key, price };
    }
  }
  return best?.price ?? DEFAULT_PRICE;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** Estimated USD cost for a bucket of tokens billed at a model's rates. */
export function estimateCost(model: string, t: TokenCounts): number {
  const p = priceFor(model);
  const cacheWrite = p.cacheWrite ?? p.input * 1.25;
  const cacheRead = p.cacheRead ?? p.input * 0.1;
  return (
    (t.input * p.input +
      t.output * p.output +
      t.cacheWrite * cacheWrite +
      t.cacheRead * cacheRead) /
    1_000_000
  );
}
