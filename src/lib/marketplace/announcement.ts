import { createHash } from "node:crypto";
import { formatEther, isAddressEqual, type Address } from "viem";
import { z } from "zod";
import { DAO_ADDRESSES } from "@/lib/config";
import type { MarketplaceOffer } from "@/types/marketplace";
import { getMarketplaceProtocolAddress } from "./routing";
import { getListingOrderHash, getListingPriceWei, listingSchema } from "./seaport";
import { buildMarketplaceShareUrl } from "./share";

export const ANNOUNCEMENT_FID = 3757;
export const ANNOUNCEMENT_EVENT = "listed";
export const ANNOUNCEMENT_AMBIGUITY_MS = 5 * 60 * 1000;

export function announcementIdentity(offer: MarketplaceOffer, rawListing: unknown) {
  const listing = listingSchema.parse(rawListing);
  const offered = listing.parameters.offer;
  const collection = offer.collectionAddress ?? DAO_ADDRESSES.token;
  if (
    offered.length !== 1 ||
    !isAddressEqual(offered[0].token, collection) ||
    !isAddressEqual(listing.parameters.offerer, offer.seller) ||
    !isAddressEqual(offer.protocolAddress, getMarketplaceProtocolAddress(offer.source)) ||
    getListingOrderHash(listing.parameters).toLowerCase() !== offer.orderHash.toLowerCase() ||
    getListingPriceWei(listing).toString() !== offer.priceWei ||
    Number(listing.parameters.endTime) !== offer.expiresAt
  )
    throw new Error("Announcement listing identity mismatch");
  const protocolAddress = offer.protocolAddress.toLowerCase();
  const orderHash = offer.orderHash.toLowerCase();
  return {
    chainId: 8453 as const,
    protocolAddress,
    orderHash,
    event: ANNOUNCEMENT_EVENT,
    tokenId: offered[0].identifierOrCriteria,
    collectionAddress: collection.toLowerCase() as Address,
    idem: createHash("sha256")
      .update(`8453:${protocolAddress}:${orderHash}:${ANNOUNCEMENT_EVENT}`)
      .digest("base64url")
      .slice(0, 16),
  };
}
export type AnnouncementIdentity = ReturnType<typeof announcementIdentity>;

export const announcementPayloadSchema = z
  .object({
    channel_id: z.literal("gnars"),
    text: z.string().min(1).max(1024),
    embeds: z.array(z.object({ url: z.string().url() }).strict()).length(1),
    idem: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  })
  .strict();

export function buildAnnouncementPayload(
  identity: AnnouncementIdentity,
  offer: MarketplaceOffer,
  name?: string | null,
) {
  const isGnar = isAddressEqual(identity.collectionAddress, DAO_ADDRESSES.token);
  const label =
    name
      ?.replace(/[\x00-\x1f\x7f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || `${isGnar ? "Gnar" : "NFT"} #${identity.tokenId}`;
  const url = buildMarketplaceShareUrl({
    tokenId: identity.tokenId,
    collectionAddress: offer.collectionAddress,
    orderHash: offer.orderHash,
    source: offer.source,
  });
  return announcementPayloadSchema.parse({
    channel_id: "gnars",
    text: `New listing on Gnars Marketplace\n${label} - ${formatEther(BigInt(offer.priceWei))} ETH`,
    embeds: [{ url }],
    idem: identity.idem,
  });
}

export function announcementRetryDelay(value: string | null, now = Date.now()) {
  if (!value) return 1000;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(1000, Math.min(24 * 60 * 60 * 1000, delay)) : 1000;
}
