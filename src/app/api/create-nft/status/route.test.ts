import { zeroAddress } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAO_ADDRESSES, MARKETPLACE_CONFIG } from "@/lib/config";
import artifact from "../../../../../contracts/gnars-community-nft/artifacts/GnarsCommunityNFT.json";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({ chain: vi.fn(), read: vi.fn(), code: vi.fn() }));
vi.mock("@/services/marketplace-common", () => ({
  marketplaceClient: { getChainId: mocks.chain, readContract: mocks.read, getCode: mocks.code },
}));
const address = "0x3333333333333333333333333333333333333333";
const config = () => ({
  gnars: DAO_ADDRESSES.token,
  royaltyRecipient: MARKETPLACE_CONFIG.communityFeeRecipient,
  royaltyBps: 100n,
  MIN_GNARS: 6n,
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXT_PUBLIC_GNARS_COMMUNITY_NFT_ADDRESS", address);
  mocks.chain.mockResolvedValue(8453);
  mocks.code.mockResolvedValue(artifact.deployedBytecode);
  mocks.read.mockImplementation(
    async ({ functionName }: { functionName: keyof ReturnType<typeof config> }) =>
      config()[functionName],
  );
});
afterEach(() => vi.unstubAllEnvs());

describe("community NFT contract readiness", () => {
  it("enables minting only after bytecode, chain and economic configuration checks", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ready: true,
      address,
      royaltyBps: 100,
      recipient: MARKETPLACE_CONFIG.communityFeeRecipient,
    });
    expect(response.headers.get("cache-control")).toBe("public, s-maxage=60");
    expect(mocks.code).toHaveBeenCalledExactlyOnceWith({ address });
    expect(mocks.read.mock.calls.map(([args]) => args.functionName).sort()).toEqual([
      "MIN_GNARS",
      "gnars",
      "royaltyBps",
      "royaltyRecipient",
    ]);
    expect(mocks.read.mock.calls.every(([args]) => args.address === address)).toBe(true);
  });
  it.each(["", "not-an-address"])(
    "returns disabled without RPC when not configured (%s)",
    async (value) => {
      vi.stubEnv("NEXT_PUBLIC_GNARS_COMMUNITY_NFT_ADDRESS", value);
      const response = await GET();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ready: false });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(mocks.chain).not.toHaveBeenCalled();
      expect(mocks.read).not.toHaveBeenCalled();
      expect(mocks.code).not.toHaveBeenCalled();
    },
  );
  it.each([1, 84532])("rejects chain %i even when contract getters match", async (chain) => {
    mocks.chain.mockResolvedValue(chain);
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty("ready", true);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it.each([undefined, "0x", "0x6000", `0xff${artifact.deployedBytecode.slice(4)}`])(
    "rejects missing or mismatched runtime",
    async (code) => {
      mocks.code.mockResolvedValue(code);
      const response = await GET();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "NFT contract verification is unavailable." });
    },
  );
  it.each([
    { gnars: zeroAddress },
    { gnars: address },
    { royaltyRecipient: zeroAddress },
    { royaltyRecipient: address },
    { MIN_GNARS: 5n },
    { MIN_GNARS: 7n },
    { royaltyBps: 0n },
    { royaltyBps: -1n },
    { royaltyBps: 10001n },
  ])("rejects changed membership or royalty configuration %o", async (override) => {
    mocks.read.mockImplementation(
      async ({ functionName }: { functionName: keyof ReturnType<typeof config> }) =>
        ({ ...config(), ...override })[functionName],
    );
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty("ready", true);
  });
  it.each(["chain", "read", "code"] as const)(
    "fails closed on %s RPC failure without exposing provider secrets",
    async (operation) => {
      mocks[operation].mockRejectedValue(new Error("https://rpc.example/private-api-key"));
      const response = await GET();
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toContain("private-api-key");
    },
  );
});
