import { zeroAddress, zeroHash } from "viem";
import { describe, expect, it } from "vitest";
import { DAO_ADDRESSES } from "@/lib/config";
import type { MarketplaceOffer } from "@/types/marketplace";
import {
  announcementIdentity,
  announcementRetryDelay,
  buildAnnouncementPayload,
} from "./announcement";
import { getListingOrderHash, SEAPORT_ADDRESS, type SignedListing } from "./seaport";

const seller = "0x1111111111111111111111111111111111111111";
const listing: SignedListing = {
  parameters: {
    offerer: seller,
    zone: zeroAddress,
    zoneHash: zeroHash,
    conduitKey: zeroHash,
    counter: "0",
    salt: "1",
    orderType: 0,
    startTime: "1",
    endTime: "2000000000",
    offer: [
      {
        itemType: 2,
        token: DAO_ADDRESSES.token,
        identifierOrCriteria: "3656",
        startAmount: "1",
        endAmount: "1",
      },
    ],
    consideration: [
      {
        itemType: 0,
        token: zeroAddress,
        identifierOrCriteria: "0",
        startAmount: "10000000000000000",
        endAmount: "10000000000000000",
        recipient: seller,
      },
    ],
  },
  signature: "0xabcd",
};
const offer: MarketplaceOffer = {
  id: "test",
  source: "gnars",
  protocolAddress: SEAPORT_ADDRESS,
  orderHash: getListingOrderHash(listing.parameters),
  seller,
  priceWei: "10000000000000000",
  currency: "ETH",
  expiresAt: 2000000000,
};

describe("marketplace announcement identity", () => {
  it("derives one stable16-character idempotency key per onchain order event", () => {
    const identity = announcementIdentity(offer, listing);
    expect(identity.idem).toMatch(/^[a-zA-Z0-9_-]{16}$/);
    expect(announcementIdentity({ ...offer, source: "opensea" }, listing).idem).toBe(identity.idem);
    const changed = { ...listing, parameters: { ...listing.parameters, salt: "2" } };
    expect(
      announcementIdentity(
        { ...offer, orderHash: getListingOrderHash(changed.parameters) },
        changed,
      ).idem,
    ).not.toBe(identity.idem);
  });
  it.each([
    { seller: zeroAddress },
    { protocolAddress: zeroAddress },
    { orderHash: zeroHash },
    { priceWei: "1" },
    { expiresAt: 1 },
    { collectionAddress: zeroAddress },
  ])("rejects mismatched accepted offer fields: %j", (change) => {
    expect(() => announcementIdentity({ ...offer, ...change }, listing)).toThrow(
      "identity mismatch",
    );
  });
  it("freezes a canonical miniapp URL, Gnars channel and exact trimmed ETH price", () => {
    const identity = announcementIdentity(offer, listing);
    const payload = buildAnnouncementPayload(identity, offer, " Gnar #3656\nLimited edition ");
    expect(payload).toMatchObject({ channel_id: "gnars", idem: identity.idem });
    expect(payload.text).toContain("Gnar #3656 Limited edition - 0.01 ETH");
    const url = new URL(payload.embeds[0].url);
    expect(url.origin).toBe("https://gnars.com");
    expect(url.pathname).toBe("/marketplace");
    expect(url.searchParams.get("nft")).toBe("3656");
    expect(url.searchParams.get("order")).toBe(offer.orderHash);
    expect(url.searchParams.get("source")).toBe("gnars");
    expect(payload).not.toHaveProperty("signer_uuid");
  });
  it("uses tokenId fallback instead of requiring metadata", () => {
    expect(buildAnnouncementPayload(announcementIdentity(offer, listing), offer).text).toContain(
      "Gnar #3656",
    );
  });
  it("honors Retry-After seconds and HTTP dates without negative delays", () => {
    expect(announcementRetryDelay("60")).toBe(60000);
    expect(
      announcementRetryDelay("Wed, 09 Sep 2026 22:01:00 GMT", Date.parse("2026-09-09T22:00:00Z")),
    ).toBe(60000);
    expect(announcementRetryDelay("bad")).toBe(1000);
    expect(announcementRetryDelay("-1")).toBe(1000);
  });
});
