import { zeroAddress, zeroHash } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getConduitOperator,
  getGnarsMarketplaceAddress,
  getListingConduitKey,
  getMarketplaceProtocolAddress,
  OPENSEA_CONDUIT_ADDRESS,
  OPENSEA_CONDUIT_KEY,
  SEAPORT_ADDRESS,
} from "./routing";

afterEach(() => vi.unstubAllEnvs());

describe("marketplace transfer routing", () => {
  it("uses the canonical OpenSea conduit only for OpenSea authored orders", () => {
    expect(getListingConduitKey("opensea")).toBe(OPENSEA_CONDUIT_KEY);
    expect(getListingConduitKey("gnars")).toBe(zeroHash);
    expect(getListingConduitKey()).toBe(zeroHash);
    expect(getConduitOperator(OPENSEA_CONDUIT_KEY)).toBe(OPENSEA_CONDUIT_ADDRESS);
    expect(getConduitOperator(zeroHash)).toBe(SEAPORT_ADDRESS);
  });
  it("rejects arbitrary transfer operators", () => {
    expect(() => getConduitOperator(`0x${"11".repeat(32)}`)).toThrow("Unsupported Seaport conduit");
  });
  it.each(["", "invalid", zeroAddress, SEAPORT_ADDRESS, OPENSEA_CONDUIT_ADDRESS])(
    "fails closed for invalid custom address %s",
    (value) => {
      vi.stubEnv("NEXT_PUBLIC_GNARS_MARKETPLACE_ADDRESS", value);
      expect(getGnarsMarketplaceAddress()).toBeNull();
      expect(() => getMarketplaceProtocolAddress("gnars-contract")).toThrow("not configured");
      expect(() => getListingConduitKey("gnars-contract")).toThrow("not configured");
      expect(getMarketplaceProtocolAddress()).toBe(SEAPORT_ADDRESS);
      expect(getMarketplaceProtocolAddress("opensea")).toBe(SEAPORT_ADDRESS);
    },
  );
  it("isolates the configured deployment from legacy routing and the OpenSea conduit", () => {
    const custom = "0x3333333333333333333333333333333333333333";
    vi.stubEnv("NEXT_PUBLIC_GNARS_MARKETPLACE_ADDRESS", custom);
    expect(getMarketplaceProtocolAddress("gnars-contract")).toBe(custom);
    expect(getListingConduitKey("gnars-contract")).toBe(zeroHash);
    expect(getConduitOperator(zeroHash, "gnars-contract")).toBe(custom);
    expect(() => getConduitOperator(OPENSEA_CONDUIT_KEY, "gnars-contract")).toThrow(
      "Unsupported Seaport conduit",
    );
    expect(getConduitOperator(zeroHash)).toBe(SEAPORT_ADDRESS);
  });
});
