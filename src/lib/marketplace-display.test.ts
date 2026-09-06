import { describe, expect, it } from "vitest";
import { parseMarketplacePrice } from "./marketplace-display";

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
