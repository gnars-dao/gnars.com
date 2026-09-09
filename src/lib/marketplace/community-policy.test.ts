import { zeroAddress } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DAO_ADDRESSES } from "@/lib/config";
import {
  COMMUNITY_FEE_RECIPIENT,
  getCommunityFeePolicy,
  getCommunityFeeWei,
  marketplaceCollectionAddress,
  validateCommunityFeePolicy,
} from "./community-policy";
import {
  buildCommunityListingQuote,
  parseCommunityQuote,
  sameListingQuote,
} from "./listing-intent";

const policy = { basisPoints: 250, recipient: COMMUNITY_FEE_RECIPIENT };
afterEach(() => vi.unstubAllEnvs());
describe("community marketplace fee policy", () => {
  it.each([undefined, "", "-1", "10000", "2.5", " 250", "0250", "abc"])(
    "fails closed for unconfigured/invalid bps %s",
    (value) => {
      vi.stubEnv("MARKETPLACE_COMMUNITY_FEE_BPS", value);
      expect(getCommunityFeePolicy()).toBeNull();
    },
  );
  it("uses explicit server configuration without changing legacy defaults", () => {
    vi.stubEnv("MARKETPLACE_COMMUNITY_FEE_BPS", "250");
    expect(getCommunityFeePolicy()).toEqual(policy);
    expect(marketplaceCollectionAddress()).toBe(DAO_ADDRESSES.token);
    expect(() => marketplaceCollectionAddress(zeroAddress)).toThrow();
  });
  it("pins the split recipient and computes integer fees", () => {
    expect(getCommunityFeeWei(10000n, policy)).toBe(250n);
    expect(getCommunityFeeWei(1n, policy)).toBe(0n);
    expect(() =>
      validateCommunityFeePolicy({ ...policy, recipient: DAO_ADDRESSES.token }),
    ).toThrow();
    expect(() => getCommunityFeeWei(0n, policy)).toThrow();
  });
  it("does not replace stored policy with a new configured rate", () => {
    vi.stubEnv("MARKETPLACE_COMMUNITY_FEE_BPS", "500");
    expect(getCommunityFeePolicy()?.basisPoints).toBe(500);
    expect(getCommunityFeeWei(10000n, policy)).toBe(250n);
  });
  it("separates platform fees, royalties and seller proceeds in the quote", () => {
    const royalty = { amount: 500n, recipient: DAO_ADDRESSES.treasury };
    const quote = buildCommunityListingQuote("10000", royalty, policy);
    expect(quote.sellerWei).toBe("9250");
    expect(quote.royaltyWei).toBe("500");
    expect(quote.fees).toEqual([{ ...policy, amountWei: "250" }]);
    expect(parseCommunityQuote(quote, "10000", royalty)).toEqual(quote);
    expect(() => parseCommunityQuote({ ...quote, sellerWei: "9999" }, "10000", royalty)).toThrow();
    expect(() => parseCommunityQuote(quote, "10000", { ...royalty, amount: 600n })).toThrow();
    expect(() =>
      buildCommunityListingQuote("10000", { ...royalty, amount: 9900n }, policy),
    ).toThrow();
  });
  it("preserves fee policy even where rounding makes the fee zero", () => {
    const quote = buildCommunityListingQuote("1", { amount: 0n, recipient: zeroAddress }, policy);
    expect(quote.fees).toEqual([]);
    expect(quote.feePolicy).toEqual(policy);
    expect(sameListingQuote(quote, { ...quote, feePolicy: { ...policy, basisPoints: 500 } })).toBe(
      false,
    );
  });
});
