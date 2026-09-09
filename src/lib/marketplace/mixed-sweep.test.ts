import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compareSweepOffers, validateMixedSweepPlan, type MixedSweepPlan } from "./mixed-sweep";
import { SEAPORT_ADDRESS } from "./routing";

const buyer = "0x1111111111111111111111111111111111111111";
const seller = "0x2222222222222222222222222222222222222222";
const native = "0x3333333333333333333333333333333333333333";
function plan(): MixedSweepPlan {
  return {
    buyer,
    totalWei: "100",
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    items: [
      {
        tokenId: "1",
        name: "Gnar #1",
        image: null,
        owner: seller,
        offers: [
          {
            id: "opensea:1",
            source: "opensea",
            orderHash: `0x${"ab".repeat(32)}`,
            protocolAddress: SEAPORT_ADDRESS,
            seller,
            currency: "ETH",
            priceWei: "100",
            expiresAt: Math.floor(Date.now() / 1000) + 120,
          },
        ],
      },
    ],
  };
}
beforeEach(() => vi.stubEnv("NEXT_PUBLIC_GNARS_MARKETPLACE_ADDRESS", native));
afterEach(() => vi.unstubAllEnvs());
describe("mixed sweep plan", () => {
  it("validates exact totals and buyer", () => {
    const raw = plan();
    expect(validateMixedSweepPlan(raw, buyer)).toEqual(raw);
    expect(() => validateMixedSweepPlan(raw, seller)).toThrow();
    expect(() => validateMixedSweepPlan({ ...raw, totalWei: "101" }, buyer)).toThrow();
  });
  it("rejects forged destinations, community assets, self-sales and duplicates", () => {
    for (const mutation of ["protocol", "self", "community", "duplicate"] as const) {
      const raw = plan();
      if (mutation === "protocol") raw.items[0].offers[0].protocolAddress = native;
      if (mutation === "self") raw.items[0].offers[0].seller = buyer;
      if (mutation === "community") raw.items[0].collectionAddress = seller;
      if (mutation === "duplicate") {
        raw.items.push(raw.items[0]);
        raw.totalWei = "200";
      }
      expect(() => validateMixedSweepPlan(raw, buyer)).toThrow();
    }
  });
  it("preserves expired cart history but refuses new purchases from expired quotes", () => {
    const raw = plan();
    raw.expiresAt = 1;
    expect(() => validateMixedSweepPlan(raw, buyer)).toThrow();
    expect(validateMixedSweepPlan(raw, buyer, true)).toEqual(raw);
    raw.expiresAt = Math.floor(Date.now() / 1000) + 90;
    raw.items[0].offers[0].expiresAt = 1;
    expect(validateMixedSweepPlan(raw, buyer, true)).toEqual(raw);
    expect(() => validateMixedSweepPlan(raw, buyer)).toThrow();
  });
  it("compares prices as bigint and breaks price ties in favor of Gnars", () => {
    const openSea = plan().items[0].offers[0];
    const gnars = { ...openSea, source: "gnars-contract", protocolAddress: native } as const;
    expect(compareSweepOffers(gnars, openSea)).toBeLessThan(0);
    expect(compareSweepOffers(openSea, gnars)).toBeGreaterThan(0);
    expect(
      compareSweepOffers(
        { ...openSea, priceWei: "9007199254740992" },
        { ...gnars, priceWei: "9007199254740993" },
      ),
    ).toBeLessThan(0);
  });
});
