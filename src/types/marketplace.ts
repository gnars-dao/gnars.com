import type { Address, Hex } from "viem";

export type MarketplaceSource = "opensea" | "gnars" | "gnars-contract";
export type MarketplaceOffer = {
  listingComment?: string;
  listingCommentRevision?: number;
  collectionAddress?: Address;
  feePolicy?: { basisPoints: number; recipient: Address };
  moderation?: { hidden: boolean; revision: number };
  id: string;
  source: MarketplaceSource;
  orderHash: Hex;
  protocolAddress: Address;
  seller: Address;
  priceWei: string;
  currency: "ETH";
  expiresAt: number;
};

export type MarketplaceItem = {
  collectionAddress?: Address;
  collectionName?: string;
  tokenId: string;
  name: string;
  image: string | null;
  owner: Address | null;
  offers: MarketplaceOffer[];
};

export type CommunityMarketplacePage = {
  items: MarketplaceItem[];
  nextCursor: string | null;
  available: boolean;
};

export type MarketplaceEligibility = {
  owner: Address;
  balance: string;
  minimum: number;
  eligible: boolean;
  feeBps: number | null;
  feeRecipient: Address;
  canModerate: boolean;
};

export type MarketplaceAvailability = {
  available: boolean;
  partial?: boolean;
  error?: "not_configured" | "unavailable";
};

export type MarketplacePage = {
  ownershipVerified?: boolean;
  items: MarketplaceItem[];
  nextCursor: string | null;
  sources: {
    catalogue: MarketplaceAvailability;
    opensea: MarketplaceAvailability;
    gnars: MarketplaceAvailability;
    "gnars-contract"?: MarketplaceAvailability;
  };
  capabilities: {
    openseaBuy: boolean;
    openseaSell: boolean;
    openseaCancel: boolean;
    localTrading: boolean;
    customTrading?: boolean;
  };
};

export type MarketplaceFulfillment = {
  transaction: { chainId: 8453; to: Address; data: Hex; value: string };
  offer: MarketplaceOffer;
};
