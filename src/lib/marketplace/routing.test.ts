import { zeroHash } from "viem";
import { describe, expect, it } from "vitest";
import {
  getConduitOperator,
  getListingConduitKey,
  OPENSEA_CONDUIT_ADDRESS,
  OPENSEA_CONDUIT_KEY,
  SEAPORT_ADDRESS,
} from "./routing";

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
});
