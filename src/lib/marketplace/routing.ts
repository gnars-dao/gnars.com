import { isAddressEqual, zeroHash, type Address, type Hex } from "viem";

export const SEAPORT_ADDRESS = "0x0000000000000068F116a894984e2DB1123eB395" as const;
// OpenSea's cross-chain conduit, as configured by the official Seaport SDK.
export const OPENSEA_CONDUIT_KEY =
  "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000" as const;
export const OPENSEA_CONDUIT_ADDRESS = "0x1e0049783f008a0085193e00003d00cd54003c71" as const;

export function getListingConduitKey(source: "gnars" | "opensea" = "gnars"): Hex {
  return source === "opensea" ? OPENSEA_CONDUIT_KEY : zeroHash;
}

export function getConduitOperator(key: Hex): Address {
  if (key === zeroHash) return SEAPORT_ADDRESS;
  if (key.toLowerCase() === OPENSEA_CONDUIT_KEY) return OPENSEA_CONDUIT_ADDRESS;
  throw new Error("Unsupported Seaport conduit");
}

export function isSupportedListingOperator(operator: Address): boolean {
  return (
    isAddressEqual(operator, SEAPORT_ADDRESS) || isAddressEqual(operator, OPENSEA_CONDUIT_ADDRESS)
  );
}
