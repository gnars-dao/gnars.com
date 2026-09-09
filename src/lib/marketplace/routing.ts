import {
  getAddress,
  isAddress,
  isAddressEqual,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { getConfiguredGnarsMarketplaceAddress } from "@/lib/config";
import type { MarketplaceSource } from "@/types/marketplace";

export const SEAPORT_ADDRESS = "0x0000000000000068F116a894984e2DB1123eB395" as const;
// OpenSea's cross-chain conduit, as configured by the official Seaport SDK.
export const OPENSEA_CONDUIT_KEY =
  "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000" as const;
export const OPENSEA_CONDUIT_ADDRESS = "0x1e0049783f008a0085193e00003d00cd54003c71" as const;

export function getGnarsMarketplaceAddress(): Address | null {
  const value = getConfiguredGnarsMarketplaceAddress();
  if (!value || !isAddress(value, { strict: false })) return null;
  const address = getAddress(value);
  if (
    [zeroAddress, SEAPORT_ADDRESS, OPENSEA_CONDUIT_ADDRESS].some((other) =>
      isAddressEqual(address, other),
    )
  )
    return null;
  return address;
}

export function getMarketplaceProtocolAddress(source: MarketplaceSource = "gnars"): Address {
  if (source === "gnars" || source === "opensea") return SEAPORT_ADDRESS;
  if (source !== "gnars-contract") throw new Error("Invalid listing destination");
  const address = getGnarsMarketplaceAddress();
  if (!address) throw new Error("Gnars marketplace contract is not configured");
  return address;
}

export function getListingConduitKey(source: MarketplaceSource = "gnars"): Hex {
  getMarketplaceProtocolAddress(source);
  return source === "opensea" ? OPENSEA_CONDUIT_KEY : zeroHash;
}

export function getConduitOperator(key: Hex, source: MarketplaceSource = "gnars"): Address {
  const protocol = getMarketplaceProtocolAddress(source);
  if (key === zeroHash) return protocol;
  if (source !== "gnars-contract" && key.toLowerCase() === OPENSEA_CONDUIT_KEY)
    return OPENSEA_CONDUIT_ADDRESS;
  throw new Error("Unsupported Seaport conduit");
}

export function isSupportedListingOperator(operator: Address): boolean {
  const custom = getGnarsMarketplaceAddress();
  return (
    isAddressEqual(operator, SEAPORT_ADDRESS) ||
    isAddressEqual(operator, OPENSEA_CONDUIT_ADDRESS) ||
    Boolean(custom && isAddressEqual(operator, custom))
  );
}
