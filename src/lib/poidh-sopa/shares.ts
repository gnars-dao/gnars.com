/**
 * Winners split: the UI edits percentages, the contract takes basis points.
 * Contract rules (PoidhSopa._validateWinners): 1..10 winners, no duplicate claim id,
 * every share > 0, shares sum to exactly 10_000.
 */

export const BPS_DENOM = 10_000;
export const MAX_WINNERS = 10;

export type ShareValidationError =
  | "noWinners"
  | "tooManyWinners"
  | "duplicateClaim"
  | "invalidNumber"
  | "zeroShare"
  | "totalNot100";

export interface ShareValidation {
  ok: boolean;
  error: ShareValidationError | null;
  /** Sum of the typed percentages (for the live "total" readout). */
  totalPercent: number;
  /** Basis points to send, remainder on the last winner. Empty when invalid. */
  sharesBps: number[];
}

/** Parses a percent string ("33.33", "33,33") to a finite number, or NaN. */
export function parsePercent(raw: string): number {
  const s = raw.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(s) && !/^\.\d+$/.test(s)) return Number.NaN;
  return Number(s);
}

/** Equal split of 10_000 bps across `n` winners; the remainder goes to the last. */
export function equalSplitBps(n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(BPS_DENOM / n);
  const out = Array.from({ length: n }, () => base);
  out[n - 1] = BPS_DENOM - base * (n - 1);
  return out;
}

/** bps → percent string with up to 2 decimals ("3333" → "33.33", "5000" → "50"). */
export function bpsToPercentString(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = bps % 100;
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
}

export function equalSplitPercents(n: number): string[] {
  return equalSplitBps(n).map(bpsToPercentString);
}

/**
 * Converts percentages to bps: each non-last share is rounded to the nearest bps, the
 * last receives `10_000 - sum(others)`. Valid only when the typed total is 100 within
 * rounding (half a bps per winner), so "33.333 ×3" passes and "50 + 40" does not.
 */
export function percentsToBps(percents: number[]): number[] {
  if (percents.length === 0) return [];
  const head = percents.slice(0, -1).map((p) => Math.round(p * 100));
  const used = head.reduce((a, b) => a + b, 0);
  return [...head, BPS_DENOM - used];
}

export function validateWinnerShares(claimIds: number[], percentInputs: string[]): ShareValidation {
  const percents = percentInputs.map(parsePercent);
  const totalPercent = percents.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const fail = (error: ShareValidationError): ShareValidation => ({
    ok: false,
    error,
    totalPercent,
    sharesBps: [],
  });

  if (claimIds.length === 0) return fail("noWinners");
  if (claimIds.length > MAX_WINNERS) return fail("tooManyWinners");
  if (new Set(claimIds).size !== claimIds.length) return fail("duplicateClaim");
  if (percents.length !== claimIds.length || percents.some((p) => !Number.isFinite(p))) {
    return fail("invalidNumber");
  }
  if (percents.some((p) => p <= 0)) return fail("zeroShare");

  const tolerance = 0.005 * percents.length + 1e-9;
  if (Math.abs(totalPercent - 100) > tolerance) return fail("totalNot100");

  const sharesBps = percentsToBps(percents);
  if (sharesBps.some((b) => b <= 0)) return fail("zeroShare");
  return { ok: true, error: null, totalPercent, sharesBps };
}

/**
 * Net payout per winner, mirroring PoidhSopa._payWinners: each fee (POIDH, Sopa — the
 * per-bounty `bountyFees` snapshot) is floored separately off the top, dust to the last.
 */
export function previewPayouts(total: bigint, sharesBps: number[], feeBps: number[]): bigint[] {
  const fees = feeBps.reduce((sum, bps) => sum + (total * BigInt(bps)) / BigInt(BPS_DENOM), 0n);
  const net = total - fees;
  let paid = 0n;
  return sharesBps.map((bps, i) => {
    const share = i === sharesBps.length - 1 ? net - paid : (net * BigInt(bps)) / BigInt(BPS_DENOM);
    paid += share;
    return share;
  });
}
