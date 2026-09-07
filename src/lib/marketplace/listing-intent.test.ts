import { zeroAddress, zeroHash, type Address } from "viem";
import { describe, expect, it } from "vitest";
import { DAO_ADDRESSES } from "@/lib/config";
import {
  assertPublishedListing,
  canCancelSavedListing,
  listingSource,
  parseOpenSeaQuote,
  sameListingQuote,
  savedListingOutcome,
} from "./listing-intent";
import { getListingOrderHash, SEAPORT_ADDRESS, type SignedListing } from "./seaport";

const seller = "0x1111111111111111111111111111111111111111" as Address;
const recipient = "0x2222222222222222222222222222222222222222" as Address;
const rawQuote = {
  priceWei: "10000",
  sellerWei: "9900",
  fees: [{ recipient, basisPoints: 100, amountWei: "100" }],
};

describe("listing destination and confirmed quote", () => {
  it("only permits cancellation recovery for a settled saved signature", () => {
    const saved = { kind: "list", phase: "saving", listing: {} };
    expect(canCancelSavedListing(saved)).toBe(true);
    expect(canCancelSavedListing(null)).toBe(false);
    expect(canCancelSavedListing({ ...saved, listing: undefined })).toBe(false);
    expect(canCancelSavedListing({ ...saved, phase: "unknown" })).toBe(false);
    expect(canCancelSavedListing({ ...saved, txHash: zeroHash })).toBe(false);
    expect(canCancelSavedListing({ ...saved, transactionIntent: {} })).toBe(false);
    expect(canCancelSavedListing({ ...saved, kind: "buy" })).toBe(false);
  });
  it("resolves lost publication responses after a sale, cancellation or expiry", () => {
    expect(savedListingOutcome([false, false, 1n, 1n], "20", 10n)).toBe("filled");
    expect(savedListingOutcome([false, true, 0n, 0n], "20", 10n)).toBe("cancelled");
    expect(savedListingOutcome([false, false, 0n, 0n], "20", 20n)).toBe("expired");
    expect(savedListingOutcome([false, false, 0n, 0n], "20", 10n)).toBeNull();
  });
  it("never reroutes legacy saved listings to OpenSea", () => {
    expect(listingSource()).toBe("gnars");
    expect(listingSource({})).toBe("gnars");
    expect(listingSource({ source: "opensea" })).toBe("opensea");
    expect(() => listingSource({ source: "other" })).toThrow();
  });
  it("checks fee arithmetic before showing or signing the quote", () => {
    const quote = parseOpenSeaQuote(rawQuote, "10000");
    expect(quote.source).toBe("opensea");
    expect(() => parseOpenSeaQuote({ ...rawQuote, sellerWei: "10000" }, "10000")).toThrow();
    expect(() => parseOpenSeaQuote(rawQuote, "20000")).toThrow();
    expect(() =>
      parseOpenSeaQuote({ ...rawQuote, fees: [{ ...rawQuote.fees[0], amountWei: "99" }] }, "10000"),
    ).toThrow();
    expect(() =>
      parseOpenSeaQuote(
        { ...rawQuote, fees: [{ ...rawQuote.fees[0], recipient: zeroAddress }] },
        "10000",
      ),
    ).toThrow();
  });
  it("requires renewed review when price, destination, rates or recipients change", () => {
    const quote = parseOpenSeaQuote(rawQuote, "10000");
    expect(sameListingQuote(quote, structuredClone(quote))).toBe(true);
    expect(sameListingQuote(quote, { ...quote, source: "gnars" })).toBe(false);
    expect(sameListingQuote(quote, { ...quote, priceWei: "20000" })).toBe(false);
    expect(
      sameListingQuote(quote, { ...quote, fees: [{ ...quote.fees[0], recipient: seller }] }),
    ).toBe(false);
    expect(
      sameListingQuote(quote, { ...quote, fees: [{ ...quote.fees[0], basisPoints: 200 }] }),
    ).toBe(false);
    expect(sameListingQuote(quote, { ...quote, fees: [] })).toBe(false);
  });
  it("does not mark an unrelated publication acknowledgement complete", () => {
    const item = {
      itemType: 0,
      token: zeroAddress,
      identifierOrCriteria: "0",
      startAmount: "9900",
      endAmount: "9900",
      recipient: seller,
    };
    const listing: SignedListing = {
      parameters: {
        offerer: seller,
        zone: zeroAddress,
        orderType: 0,
        startTime: "1",
        endTime: "2",
        zoneHash: zeroHash,
        salt: "3",
        conduitKey: zeroHash,
        counter: "0",
        offer: [
          {
            itemType: 2,
            token: DAO_ADDRESSES.token,
            identifierOrCriteria: "42",
            startAmount: "1",
            endAmount: "1",
          },
        ],
        consideration: [item, { ...item, recipient, startAmount: "100", endAmount: "100" }],
      },
      signature: "0x12",
    };
    const offer = {
      id: "test",
      source: "opensea" as const,
      orderHash: getListingOrderHash(listing.parameters),
      protocolAddress: SEAPORT_ADDRESS,
      seller,
      priceWei: "10000",
      currency: "ETH" as const,
      expiresAt: 2,
    };
    expect(() => assertPublishedListing(offer, listing, "opensea")).not.toThrow();
    expect(() =>
      assertPublishedListing({ ...offer, orderHash: zeroHash }, listing, "opensea"),
    ).toThrow();
    expect(() =>
      assertPublishedListing({ ...offer, priceWei: "9999" }, listing, "opensea"),
    ).toThrow();
    expect(() => assertPublishedListing(offer, listing, "gnars")).toThrow();
  });
});
