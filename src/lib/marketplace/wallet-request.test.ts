import { describe, expect, it } from "vitest";
import { isMarketplaceWalletRejection } from "./wallet-request";

describe("marketplace wallet refusal classification", () => {
  it("accepts explicit EIP1193 and ethers wallet refusal codes, including wrappers", () => {
    expect(isMarketplaceWalletRejection({ code: 4001 })).toBe(true);
    expect(isMarketplaceWalletRejection({ cause: { code: "ACTION_REJECTED" } })).toBe(true);
  });
  it.each([
    new Error("User rejected the transaction"),
    { code: -32000, message: "Request rejected by RPC after a possible broadcast" },
    { code: "4001", message: "Transaction was rejected" },
    { name: "UserRejectedRequestError" },
    null,
  ])("keeps the unknown-outcome barrier for %s", (error) => {
    expect(isMarketplaceWalletRejection(error)).toBe(false);
  });
  it("bounds recursive and cyclic cause chains", () => {
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(isMarketplaceWalletRejection(cyclic)).toBe(false);
  });
});
