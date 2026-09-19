import { beforeEach, describe, expect, it, vi } from "vitest";
import { DAO_ADDRESSES } from "@/lib/config";
import { IPFS_GATEWAYS } from "@/lib/ipfs";
import { getMarketplaceTraits } from "./marketplace-traits";

const mocks = vi.hoisted(() => ({ read: vi.fn(), chain: vi.fn(), fetch: vi.fn() }));
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock("@/services/marketplace-common", async (original) => ({
  ...(await original<typeof import("@/services/marketplace-common")>()),
  marketplaceClient: { readContract: mocks.read, getChainId: mocks.chain },
}));
const collection = DAO_ADDRESSES.token;
const cid = `Qm${"a".repeat(44)}`;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.chain.mockResolvedValue(8453);
  mocks.read.mockResolvedValue("data:application/json,%7B%7D");
});
describe("tokenURI traits service", () => {
  it("uses the requested collection and canonical token identity without HTTP for inline data", async () => {
    mocks.read.mockResolvedValue(
      `data:application/json;base64,${Buffer.from(JSON.stringify({ properties: { head: "Cap" } })).toString("base64")}`,
    );
    expect(await getMarketplaceTraits(collection, "12")).toEqual({
      collectionAddress: expect.any(String),
      tokenId: "12",
      traits: [{ type: "head", value: "Cap" }],
      source: "tokenURI",
    });
    expect(mocks.read).toHaveBeenCalledWith(
      expect.objectContaining({
        address: expect.any(String),
        functionName: "tokenURI",
        args: [12n],
      }),
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("distinguishes a valid empty trait list from failure", async () => {
    expect(await getMarketplaceTraits(collection, "12")).toMatchObject({ traits: [] });
    mocks.read.mockRejectedValue(new Error("RPC down"));
    await expect(getMarketplaceTraits(collection, "12")).rejects.toMatchObject({ status: 503 });
  });
  it("tries only fixed gateways with redirects disabled", async () => {
    mocks.read.mockResolvedValue(`ipfs://${cid}/12.json`);
    mocks.fetch.mockRejectedValueOnce(new Error("gateway failed"));
    mocks.fetch.mockResolvedValueOnce(
      Response.json({ attributes: [{ trait_type: "Color", value: "Red" }] }),
    );
    expect(await getMarketplaceTraits(collection, "12")).toMatchObject({
      traits: [{ type: "Color", value: "Red" }],
    });
    expect(mocks.fetch).toHaveBeenNthCalledWith(
      1,
      `${IPFS_GATEWAYS[0]}${cid}/12.json`,
      expect.objectContaining({
        redirect: "error",
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(mocks.fetch).toHaveBeenNthCalledWith(
      2,
      `${IPFS_GATEWAYS[1]}${cid}/12.json`,
      expect.anything(),
    );
  });
  it.each([
    "http://127.0.0.1/private",
    "https://metadata.example/12",
    "file:///etc/passwd",
    `ipfs://${cid}/%2e%2e/private`,
    `ipfs://${cid}?redirect=https://example.com`,
    `ipfs://${cid}/%5cprivate`,
    `ipfs://${cid}/%zz`,
  ])("never fetches unsafe token URI %s", async (uri) => {
    mocks.read.mockResolvedValue(uri);
    await expect(getMarketplaceTraits(collection, "12")).rejects.toMatchObject({ status: 503 });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("bounds gateway attempts and rejects oversized responses", async () => {
    mocks.read.mockResolvedValue(`ipfs://${cid}`);
    mocks.fetch.mockImplementation(async () => new Response("x".repeat(256001)));
    await expect(getMarketplaceTraits(collection, "12")).rejects.toMatchObject({ status: 503 });
    expect(mocks.fetch).toHaveBeenCalledTimes(IPFS_GATEWAYS.length);
  });
  it("returns an error for malformed trait metadata and wrong-chain reads", async () => {
    mocks.read.mockResolvedValue("data:application/json,%7B%22attributes%22%3A%7B%7D%7D");
    await expect(getMarketplaceTraits(collection, "12")).rejects.toMatchObject({ status: 503 });
    mocks.chain.mockResolvedValue(1);
    mocks.read.mockClear();
    await expect(getMarketplaceTraits(collection, "12")).rejects.toMatchObject({ status: 503 });
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
