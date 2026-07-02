/**
 * Model pricing — re-exported from the shared canonical module so the CLI and
 * the server can never drift apart again (they used to hold separate stale
 * copies of this table). The shared module resolves exact model ids against a
 * LiteLLM-derived snapshot (the same pricing database ccusage uses) with
 * family fallbacks; unknown models price to 0. esbuild bundles the shared
 * package into the published CLI, so this adds no runtime dependency.
 *
 * `loadLivePricing` (pricing-live.ts) merges fresh LiteLLM rates over the
 * baked snapshot at the start of a collection run.
 */
export {
  estimateCostUSD,
  cacheSavingsUSD,
  resolveModelPrice,
  type PricingTokenCounts as TokenCounts,
} from "./shared.js";
