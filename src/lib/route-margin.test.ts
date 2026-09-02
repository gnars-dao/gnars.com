import { describe, expect, it } from "vitest";
import { minOutAtMargin, routeMarginBps, routeMarginFromQuotes } from "./route-margin";

const E = 10n ** 18n;

describe("routeMarginBps", () => {
  it("tightens a deep route to the floor", () => {
    expect(routeMarginBps(0)).toBe(50);
    expect(routeMarginBps(0.4)).toBe(51);
  });
  it("keeps a cushion above the measured impact", () => {
    expect(routeMarginBps(120)).toBe(170);
  });
  it("caps a shallow route at the ceiling", () => {
    expect(routeMarginBps(900)).toBe(500);
  });
  it("falls back to the ceiling when the impact is unknown", () => {
    expect(routeMarginBps(null)).toBe(500);
    expect(routeMarginBps(Number.NaN)).toBe(500);
  });
});

describe("routeMarginFromQuotes / minOutAtMargin", () => {
  it("derives the margin from a 1% slice and the full balance", () => {
    // slice 1 → 100; full 100 → 9_800 (2% impact) → 2.5% margin.
    expect(routeMarginFromQuotes(1n * E, 100n, 100n * E, 9_800n)).toBe(250);
  });
  it("computes the router minimum", () => {
    expect(minOutAtMargin(10_000n, 250)).toBe(9_750n);
    expect(minOutAtMargin(10_000n, 500)).toBe(9_500n);
  });
});
