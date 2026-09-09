/**
 * Price impact of selling `fullIn` given a small reference quote, as a number.
 *
 * Zora's quote endpoint returns amountOut only — no price-impact field. So we
 * quote a small slice for the marginal price and the full balance for the
 * realised price, and report the gap: 1 − (fullOut/fullIn) / (refOut/refIn).
 * That is the cost of selling into the pool at this size, which the thin old
 * $gnars pool makes worth showing as a figure rather than a warning.
 *
 * Returns basis points (0..10000), clamped at 0 when the full sale somehow
 * quotes better per unit than the slice (tiny-size rounding). `null` when a
 * quote is missing or zero, so the UI can say "unknown" instead of "0%".
 */
export function priceImpactBps(
  refIn: bigint,
  refOut: bigint,
  fullIn: bigint,
  fullOut: bigint,
): number | null {
  if (refIn <= 0n || refOut <= 0n || fullIn <= 0n || fullOut < 0n) return null;
  // realised/marginal = (fullOut * refIn) / (fullIn * refOut), in bps of 10000.
  const ratioBps = (fullOut * refIn * 10_000n) / (fullIn * refOut);
  const impact = 10_000n - ratioBps;
  if (impact < 0n) return 0;
  if (impact > 10_000n) return 10_000;
  return Number(impact);
}

/** A reference slice for the marginal-price quote: 1% of the balance, at least 1 unit. */
export function referenceSlice(balance: bigint, decimals = 18): bigint {
  const onePercent = balance / 100n;
  const oneUnit = 10n ** BigInt(decimals);
  const slice = onePercent > oneUnit ? onePercent : oneUnit;
  return slice > balance ? balance : slice;
}
