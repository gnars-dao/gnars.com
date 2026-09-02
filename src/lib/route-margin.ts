import { priceImpactBps } from "@/lib/price-impact";

/**
 * Slippage margin for one sell route, from its measured price impact.
 *
 * The router enforces `amountOutMin = quote × (1 − margin)` and the batch
 * deposits exactly that minimum, so the margin is also how much of the proceeds
 * can be left in the wallet. A fixed 5% was too loose for deep routes and only
 * just enough for shallow ones. Deriving it per route from the impact between a
 * 1% slice and the full balance keeps a shallow pool's cushion and tightens a
 * deep one's remainder.
 *
 *   margin = clamp(impact + 50 bps, 50 bps, 500 bps)
 *
 * Unknown impact (a reference quote failed) falls back to the maximum.
 */
export const ROUTE_MARGIN_MIN_BPS = 50;
export const ROUTE_MARGIN_MAX_BPS = 500;
export const ROUTE_MARGIN_BUFFER_BPS = 50;

export function routeMarginBps(impactBps: number | null): number {
  if (impactBps === null || !Number.isFinite(impactBps)) return ROUTE_MARGIN_MAX_BPS;
  const raw = Math.ceil(impactBps) + ROUTE_MARGIN_BUFFER_BPS;
  return Math.min(ROUTE_MARGIN_MAX_BPS, Math.max(ROUTE_MARGIN_MIN_BPS, raw));
}

/** Margin from the two quotes directly. */
export function routeMarginFromQuotes(
  refIn: bigint,
  refOut: bigint,
  fullIn: bigint,
  fullOut: bigint,
): number {
  return routeMarginBps(priceImpactBps(refIn, refOut, fullIn, fullOut));
}

/** The router's guaranteed minimum for a quote at this margin. */
export function minOutAtMargin(amountOut: bigint, marginBps: number): bigint {
  return (amountOut * BigInt(10_000 - marginBps)) / 10_000n;
}

/**
 * Zora's quote endpoint returns `amountOut` ALREADY reduced by the slippage you
 * asked for — it is the router's amountOutMin, not the expected output.
 * Verified 2026-09-02: the same sale quoted at 0.5%, 1%, 5% and 10% came back
 * as expected × (1 − slippage) each time, and a fork execution delivered
 * exactly quote ÷ 0.95 at 5%. So the expected amount is recovered by dividing
 * the slippage back out, and a quote taken at the route's margin IS the
 * deposit minimum — never apply the margin a second time.
 */
export function expectedFromZoraQuote(amountOut: bigint, slippage: number): bigint {
  const bps = BigInt(Math.round(slippage * 10_000));
  if (bps <= 0n || bps >= 10_000n) return amountOut;
  return (amountOut * 10_000n) / (10_000n - bps);
}
