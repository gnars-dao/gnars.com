import { zeroAddress, zeroHash, type Address } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAO_ADDRESSES } from "@/lib/config";
import { GNARS_MARKETPLACE_FEE_POLICY } from "./community-policy";
import { getListingOrderHash, type SignedListing } from "./seaport";
import { getSweepFulfillment, type SweepQuote } from "./sweep";
import { validateSweepQuote, validateSweepSnapshot, verifySweepIntent } from "./sweep-journal";

const protocol = "0xC35813d40961151c11C97cB9d67D0D25CD4Cc86e" as Address;
const seller = "0x1111111111111111111111111111111111111111" as Address;
const buyer = "0x2222222222222222222222222222222222222222" as Address;
function quote(): SweepQuote {
  const now = Math.floor(Date.now() / 1000);
  const listings: SignedListing[] = ["42", "43"].map((id) => ({
    parameters: {
      offerer: seller,
      zone: zeroAddress,
      zoneHash: zeroHash,
      conduitKey: zeroHash,
      offer: [
        {
          itemType: 2,
          token: DAO_ADDRESSES.token,
          identifierOrCriteria: id,
          startAmount: "1",
          endAmount: "1",
        },
      ],
      consideration: [
        {
          itemType: 0,
          token: zeroAddress,
          identifierOrCriteria: "0",
          startAmount: "990",
          endAmount: "990",
          recipient: seller,
        },
        {
          itemType: 0,
          token: zeroAddress,
          identifierOrCriteria: "0",
          startAmount: "10",
          endAmount: "10",
          recipient: GNARS_MARKETPLACE_FEE_POLICY.recipient,
        },
      ],
      orderType: 0,
      startTime: String(now - 1),
      endTime: String(now + 86400),
      salt: id,
      counter: "0",
    },
    signature: "0x1234",
  }));
  return {
    listings,
    protocolAddress: protocol,
    totalWei: "2000",
    expiresAt: now + 90,
    items: listings.map((listing) => ({
      tokenId: listing.parameters.offer[0].identifierOrCriteria,
      name: "Gnar",
      image: null,
      owner: seller,
      offers: [
        {
          id: "fixture",
          source: "gnars-contract",
          orderHash: getListingOrderHash(listing.parameters),
          protocolAddress: protocol,
          seller,
          priceWei: "1000",
          currency: "ETH",
          expiresAt: now + 86400,
        },
      ],
    })),
  };
}
beforeEach(() => vi.stubEnv("NEXT_PUBLIC_GNARS_MARKETPLACE_ADDRESS", protocol));
afterEach(() => vi.unstubAllEnvs());
describe("sweep review and journal", () => {
  it("retains all signed orders and exact consideration", () => {
    const reviewed = quote();
    expect(validateSweepQuote(reviewed, buyer)).toEqual(reviewed);
    expect(validateSweepSnapshot(reviewed, buyer).listings).toEqual(reviewed.listings);
  });
  it("rejects a changed protocol, duplicate NFT and self purchase", () => {
    expect(() => validateSweepSnapshot({ ...quote(), protocolAddress: buyer }, buyer)).toThrow(
      "protocol",
    );
    expect(() => validateSweepSnapshot(quote(), seller)).toThrow("own listing");
    const duplicate = quote();
    duplicate.listings[1] = duplicate.listings[0];
    expect(() => validateSweepSnapshot(duplicate, buyer)).toThrow("Duplicate");
  });
  it("requires the visible NFT, source, hash and price to match signed orders", () => {
    for (const field of ["token", "hash", "source", "price", "total"] as const) {
      const changed = quote();
      if (field === "token") changed.items[1].tokenId = "99";
      if (field === "hash") changed.items[1].offers[0].orderHash = zeroHash;
      if (field === "source") changed.items[1].offers[0].source = "opensea";
      if (field === "price") changed.items[1].offers[0].priceWei = "1";
      if (field === "total") changed.totalWei = "1";
      expect(() => validateSweepQuote(changed, buyer)).toThrow();
    }
  });
  it("expired review cannot send, but its signed journal remains recoverable", () => {
    const expired = quote();
    expired.expiresAt = 1;
    expect(() => validateSweepQuote(expired, buyer)).toThrow("expired");
    for (const listing of expired.listings) {
      listing.parameters.startTime = "1";
      listing.parameters.endTime = "2";
    }
    expect(validateSweepSnapshot(expired, buyer).listings).toEqual(expired.listings);
  });
  it("binds recovery to the exact complete batch calldata and value", () => {
    const saved = quote();
    const call = getSweepFulfillment(saved.listings);
    const intent = { account: buyer, ...call, value: call.value.toString(), startedBlock: "10" };
    expect(() => verifySweepIntent(saved, intent)).not.toThrow();
    expect(() => verifySweepIntent(saved, { ...intent, to: buyer })).toThrow();
    expect(() => verifySweepIntent(saved, { ...intent, value: "1000" })).toThrow();
    expect(() =>
      verifySweepIntent(saved, { ...intent, data: getSweepFulfillment([saved.listings[0]]).data }),
    ).toThrow();
    saved.listings[1].signature = "0xabcd";
    expect(() => verifySweepIntent(saved, intent)).toThrow();
  });
});
