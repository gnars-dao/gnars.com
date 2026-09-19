import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { parseMarketplaceBrowseFilters, parseMarketplacePriceRange } from "./browse-filters";

describe("marketplace browse filters", () => {
  it("keeps unfiltered API defaults and accepts exact inclusive bounds", () => {
    expect(parseMarketplaceBrowseFilters({})).toEqual({});
    expect(parseMarketplaceBrowseFilters({ minPriceWei: "1", maxPriceWei: "1" })).toEqual({
      minPriceWei: "1",
      maxPriceWei: "1",
    });
    expect(
      parseMarketplaceBrowseFilters({ maxPriceWei: (2n ** 256n - 1n).toString() }),
    ).toHaveProperty("maxPriceWei", (2n ** 256n - 1n).toString());
  });

  it.each(["-1", "1.1", "1e18", "01", "", (2n ** 256n).toString(), "9".repeat(79)])(
    "rejects noncanonical or overflowing wei %s",
    (minPriceWei) => {
      expect(() => parseMarketplaceBrowseFilters({ minPriceWei })).toThrow();
    },
  );

  it("rejects reversed bounds, unsupported sorting and unknown fields", () => {
    expect(() => parseMarketplaceBrowseFilters({ minPriceWei: "2", maxPriceWei: "1" })).toThrow();
    expect(() => parseMarketplaceBrowseFilters({ sort: "price-desc" })).toThrow();
    expect(() => parseMarketplaceBrowseFilters({ price: "1" })).toThrow();
    expect(() =>
      parseMarketplaceBrowseFilters({ minPriceWei: "invalid", maxPriceWei: "1" }),
    ).toThrow(ZodError);
  });

  it("converts localized input without floating-point rounding", () => {
    expect(parseMarketplacePriceRange(" 0,000000000000000001 ", "0.01")).toEqual({
      sort: "price-asc",
      minPriceWei: "1",
      maxPriceWei: "10000000000000000",
    });
    expect(parseMarketplacePriceRange("0", "")).toEqual({
      sort: "price-asc",
      minPriceWei: "0",
      maxPriceWei: undefined,
    });
  });

  it.each(["-1", "1e-3", ".01", "0.0000000000000000001", "1,2,3", "NaN", "Infinity"])(
    "rejects ambiguous or excessive precision input %s",
    (min) => {
      expect(() => parseMarketplacePriceRange(min, "")).toThrow();
    },
  );

  it("does not accept reversed ETH bounds", () => {
    expect(() => parseMarketplacePriceRange("0.02", "0.01")).toThrow();
  });
});
