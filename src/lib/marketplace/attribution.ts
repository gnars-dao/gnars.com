import { bytesToBigInt } from "viem";
import { BUILDER_CODE } from "@/lib/config";

/**
 * Binds app provenance into the signed Seaport salt, without changing its EIP-712
 * schema. This is not ERC-8021 attribution; onchain calls still need their suffix.
 */
export function generateMarketplaceSalt(): string {
  const prefix = new TextEncoder().encode(BUILDER_CODE);
  if (prefix.length > 16 || prefix.some((byte) => byte > 127)) {
    throw new Error("Marketplace builder code must be ASCII and leave 128 bits of salt entropy");
  }
  const salt = new Uint8Array(32);
  salt.set(prefix);
  salt.set(crypto.getRandomValues(new Uint8Array(salt.length - prefix.length)), prefix.length);
  return bytesToBigInt(salt).toString();
}
