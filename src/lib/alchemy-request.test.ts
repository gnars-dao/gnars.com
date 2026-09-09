import { describe, expect, it } from "vitest";
import { alchemyRequestSchema } from "./alchemy-request";

const address = "0x1111111111111111111111111111111111111111";
describe("public RPC allowlist", () => {
  it("accepts only the reads used by the treasury", () => {
    expect(
      alchemyRequestSchema.safeParse({ method: "eth_getBalance", params: [address, "latest"] })
        .success,
    ).toBe(true);
    expect(
      alchemyRequestSchema.safeParse({
        method: "alchemy_getTokenBalances",
        params: [address, [address]],
      }).success,
    ).toBe(true);
    expect(
      alchemyRequestSchema.safeParse({ method: "alchemy_getTokenMetadata", params: [address] })
        .success,
    ).toBe(true);
  });
  it("rejects arbitrary RPC methods, invalid addresses, oversized arrays and extra arguments", () => {
    for (const input of [
      { method: "debug_traceTransaction", params: [] },
      { method: "eth_sendRawTransaction", params: ["0x123"] },
      { method: "eth_getBalance", params: ["garbage", "latest"] },
      { method: "alchemy_getTokenBalances", params: [address, Array(101).fill(address)] },
      { method: "alchemy_getTokenMetadata", params: [address, address] },
    ])
      expect(alchemyRequestSchema.safeParse(input).success).toBe(false);
  });
});
