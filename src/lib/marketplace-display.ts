import { formatEther, parseEther } from "viem";

/** Display only: retain the original wei amount for every transaction. */
export function formatMarketplacePrice(priceWei: string) {
  const wei = BigInt(priceWei);
  const exact = formatEther(wei);
  if (wei === 0n) return { exact, display: "0", rounded: false };
  if (wei < 0n) throw new Error("Marketplace price cannot be negative");

  const decimalUnit = 10n ** 14n;
  if (wei >= decimalUnit && wei < 10n ** 25n) {
    const roundedWei = ((wei + decimalUnit / 2n) / decimalUnit) * decimalUnit;
    return { exact, display: formatEther(roundedWei), rounded: roundedWei !== wei };
  }

  // Scientific notation keeps dust and very large amounts legible without zeroing them.
  const unit = 10n ** BigInt(Math.max(0, wei.toString().length - 4));
  const roundedWei = ((wei + unit / 2n) / unit) * unit;
  const digits = roundedWei.toString();
  const fraction = digits.slice(1, 4).replace(/0+$/, "");
  const coefficient = digits[0] + (fraction ? `.${fraction}` : "");
  const exponent = digits.length - 19;
  return {
    exact,
    display: `${coefficient}e${exponent >= 0 ? "+" : ""}${exponent}`,
    rounded: roundedWei !== wei,
  };
}

/** Reject excess precision instead of rounding an amount the seller entered. */
export function parseMarketplacePrice(input: string): bigint | null {
  const normalized = input.trim().replace(",", ".");
  if (!/^(?:0|[1-9][0-9]{0,59})(?:\.[0-9]{1,18})?$/.test(normalized)) return null;
  const value = parseEther(normalized);
  return value > 0n && value < 2n ** 256n ? value : null;
}
