import { parseEther } from "viem";

/** Reject excess precision instead of rounding an amount the seller entered. */
export function parseMarketplacePrice(input: string): bigint | null {
  const normalized = input.trim().replace(",", ".");
  if (!/^(?:0|[1-9][0-9]{0,59})(?:\.[0-9]{1,18})?$/.test(normalized)) return null;
  const value = parseEther(normalized);
  return value > 0n && value < 2n ** 256n ? value : null;
}
