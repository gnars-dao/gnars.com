import type { Address, Hex } from "viem";

export type MarketplaceSource = "opensea" | "gnars" | "gnars-contract";
export type MarketplaceOffer = {
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
  tokenId: string;
  name: string;
  image: string | null;
  owner: Address | null;
  offers: MarketplaceOffer[];
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
