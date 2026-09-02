import { describe, expect, it } from "vitest";
import { priceImpactBps, referenceSlice } from "./price-impact";

const E = 10n ** 18n;

describe("priceImpactBps", () => {
  it("is 0 when the full sale gets the same unit price as the slice", () => {
    expect(priceImpactBps(1n * E, 100n, 100n * E, 10_000n)).toBe(0);
  });

  it("reports the gap between marginal and realised price in bps", () => {
    // slice: 1 unit → 100 wei; full: 100 units → 8_000 wei (80 per unit) → 20% impact.
    expect(priceImpactBps(1n * E, 100n, 100n * E, 8_000n)).toBe(2_000);
  });

  it("clamps to 0 when rounding makes the full sale look better per unit", () => {
    expect(priceImpactBps(1n * E, 100n, 100n * E, 10_500n)).toBe(0);
  });

  it("caps at 100%", () => {
    expect(priceImpactBps(1n * E, 100n, 100n * E, 0n)).toBe(10_000);
  });

  it("is null, not 0, when a quote is missing", () => {
    expect(priceImpactBps(0n, 100n, 100n * E, 8_000n)).toBeNull();
    expect(priceImpactBps(1n * E, 0n, 100n * E, 8_000n)).toBeNull();
    expect(priceImpactBps(1n * E, 100n, 0n, 8_000n)).toBeNull();
  });
});

describe("referenceSlice", () => {
  it("is 1% of a large balance", () => {
    expect(referenceSlice(6_000_000n * E)).toBe(60_000n * E);
  });
  it("is at least one whole unit", () => {
    expect(referenceSlice(50n * E)).toBe(1n * E);
  });
  it("never exceeds the balance", () => {
    expect(referenceSlice(E / 2n)).toBe(E / 2n);
  });
});
