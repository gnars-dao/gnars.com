import { describe, expect, it } from "vitest";
import { formatMarketplacePrice, parseMarketplacePrice } from "./marketplace-display";

describe("formatMarketplacePrice", () => {
  it("rounds card prices to four decimals and preserves exact ETH", () => {
    expect(formatMarketplacePrice("8489987998790000")).toEqual({
      exact: "0.00848998799879",
      display: "0.0085",
      rounded: true,
    });
  });

  it("keeps already short prices exact", () => {
    expect(formatMarketplacePrice("12300000000000000")).toEqual({
      exact: "0.0123",
      display: "0.0123",
      rounded: false,
    });
    expect(formatMarketplacePrice("20000000000000000").display).toBe("0.02");
  });

  it("never rounds small nonzero prices to zero", () => {
    expect(formatMarketplacePrice("1")).toEqual({
      exact: "0.000000000000000001",
      display: "1e-18",
      rounded: false,
    });
    expect(formatMarketplacePrice("123456789").display).toBe("1.235e-10");
    expect(formatMarketplacePrice("99999999999").display).toBe("1e-7");
  });

  it("handles huge values with bigint precision", () => {
    expect(formatMarketplacePrice("12345000000000000000000000000000000000000")).toEqual({
      exact: "12345000000000000000000",
      display: "1.235e+22",
      rounded: true,
    });
  });

  it("handles rounding carry and zero without losing their meaning", () => {
    expect(formatMarketplacePrice("999990000000000000").display).toBe("1");
    expect(formatMarketplacePrice("0")).toEqual({ exact: "0", display: "0", rounded: false });
    expect(() => formatMarketplacePrice("-1")).toThrow();
  });
});

describe("marketplace price input", () => {
  it("preserves wei and supports a Portuguese decimal separator", () => {
    expect(parseMarketplacePrice("0.000000000000000001")).toBe(1n);
    expect(parseMarketplacePrice(" 0,02 ")).toBe(20000000000000000n);
  });
  it.each([
    "",
    "0",
    "-1",
    "1e3",
    "0.0000000000000000001",
    "1,000.5",
    "NaN",
    "1.2.3",
    "1".repeat(78),
  ])("rejects invalid price %s", (value) => {
    expect(parseMarketplacePrice(value)).toBeNull();
  });
});
