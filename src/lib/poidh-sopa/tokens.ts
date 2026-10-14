import { formatUnits, zeroAddress } from "viem";
import { POIDH_SOPA, type PoidhSopaToken } from "@/lib/config";
import { normalizeDecimalInput } from "@/lib/decimal-input";

export function isEthToken(address: string): boolean {
  return address.toLowerCase() === zeroAddress;
}

/** Configured token for an on-chain token address; unknown tokens get a placeholder. */
export function findSopaToken(
  address: string,
  tokens: readonly PoidhSopaToken[] = POIDH_SOPA.tokens,
): PoidhSopaToken | undefined {
  return tokens.find((t) => t.address.toLowerCase() === address.toLowerCase());
}

/**
 * Formats raw token units for display without going through floats.
 * Truncates (never rounds up) to `maxFractionDigits` and trims trailing zeros.
 * A non-zero amount that truncates to zero renders as `<0.0001`-style.
 */
export function formatTokenAmount(
  raw: bigint | string,
  decimals: number,
  maxFractionDigits = 4,
): string {
  const value = typeof raw === "bigint" ? raw : BigInt(raw || "0");
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const full = formatUnits(abs, decimals);
  const [whole, fraction = ""] = full.split(".");
  const cut = fraction.slice(0, maxFractionDigits).replace(/0+$/, "");
  const wholeGrouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (abs > 0n && whole === "0" && cut === "" && maxFractionDigits > 0) {
    return `${negative ? "-" : ""}<0.${"0".repeat(maxFractionDigits - 1)}1`;
  }
  return `${negative ? "-" : ""}${wholeGrouped}${cut ? `.${cut}` : ""}`;
}

/** "250 USDC" / "0.05 ETH" for an on-chain token address. */
export function formatSopaReward(
  raw: bigint | string,
  tokenAddress: string,
  tokens: readonly PoidhSopaToken[] = POIDH_SOPA.tokens,
): string {
  const token = findSopaToken(tokenAddress, tokens);
  if (!token) return `${formatTokenAmount(raw, 18)} ?`;
  const digits = token.decimals <= 6 ? 2 : 4;
  return `${formatTokenAmount(raw, token.decimals, digits)} ${token.symbol}`;
}

/**
 * Parses what a person typed into raw token units. Accepts comma decimals.
 * Returns null for empty, zero, malformed, or more fraction digits than the token has
 * (silently rounding a reward is worse than refusing it).
 */
export function parseTokenAmountInput(input: string, decimals: number): bigint | null {
  const s = normalizeDecimalInput(input.trim());
  if (!s || s === ".") return null;
  const [whole = "", fraction = ""] = s.split(".");
  if (fraction.length > decimals) return null;
  const digits = `${whole || "0"}${fraction.padEnd(decimals, "0")}`;
  if (!/^\d+$/.test(digits)) return null;
  const value = BigInt(digits);
  return value > 0n ? value : null;
}
