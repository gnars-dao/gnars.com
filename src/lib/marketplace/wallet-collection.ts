import { getAddress, isAddress, zeroAddress, type Address } from "viem";

export function parseWalletCollection(input: string): Address | null {
  let value = input.trim();
  if (value.startsWith("https://")) {
    try {
      const url = new URL(value);
      if (
        !["opensea.io", "www.opensea.io"].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.port
      )
        return null;
      const match = url.pathname.match(/^\/(?:item|assets)\/base\/(0x[0-9a-fA-F]{40})\/\d+\/?$/);
      if (!match) return null;
      value = match[1];
    } catch {
      return null;
    }
  }
  return isAddress(value, { strict: false }) && value.toLowerCase() !== zeroAddress
    ? getAddress(value)
    : null;
}
