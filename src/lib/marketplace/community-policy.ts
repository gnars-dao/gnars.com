import { isAddress, isAddressEqual, zeroAddress, type Address } from "viem";
import { DAO_ADDRESSES, MARKETPLACE_CONFIG } from "@/lib/config";

export const COMMUNITY_FEE_RECIPIENT = MARKETPLACE_CONFIG.communityFeeRecipient;
export const MIN_COMMUNITY_GNARS = 6;
export type CommunityFeePolicy = { basisPoints: number; recipient: Address };

export function validateCommunityFeePolicy(raw: unknown): CommunityFeePolicy {
  if (!raw || typeof raw !== "object") throw new Error("Community fee policy required");
  const policy = raw as CommunityFeePolicy;
  if (
    !Number.isInteger(policy.basisPoints) ||
    policy.basisPoints < 0 ||
    policy.basisPoints > 9999 ||
    typeof policy.recipient !== "string" ||
    !isAddress(policy.recipient, { strict: false }) ||
    !isAddressEqual(policy.recipient, COMMUNITY_FEE_RECIPIENT)
  )
    throw new Error("Invalid community fee policy");
  return { basisPoints: policy.basisPoints, recipient: COMMUNITY_FEE_RECIPIENT };
}

/** Server configuration only; clients receive an explicit, checked quote snapshot. */
export function getCommunityFeePolicy(): CommunityFeePolicy | null {
  const value = process.env.MARKETPLACE_COMMUNITY_FEE_BPS;
  if (value === undefined || !/^(0|[1-9]\d{0,3})$/.test(value)) return null;
  return validateCommunityFeePolicy({
    basisPoints: Number(value),
    recipient: COMMUNITY_FEE_RECIPIENT,
  });
}

export function getCommunityFeeWei(price: bigint, raw: CommunityFeePolicy): bigint {
  if (price <= 0n || price >= 2n ** 256n) throw new Error("Invalid listing price");
  const policy = validateCommunityFeePolicy(raw);
  return (price * BigInt(policy.basisPoints)) / 10000n;
}

export function marketplaceCollectionAddress(collectionAddress?: Address): Address {
  if (collectionAddress === undefined) return DAO_ADDRESSES.token;
  if (
    !isAddress(collectionAddress, { strict: false }) ||
    isAddressEqual(collectionAddress, zeroAddress)
  )
    throw new Error("Invalid NFT collection address");
  return collectionAddress;
}
