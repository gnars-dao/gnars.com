import { beforeEach, describe, expect, it, vi } from "vitest";
import { DAO_ADDRESSES } from "@/lib/config";
import { getMarketplaceCatalogue } from "./marketplace-catalogue";

const mocks = vi.hoisted(() => ({ query: vi.fn(), owners: vi.fn() }));
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock("@/lib/subgraph", () => ({ subgraphQuery: mocks.query }));
vi.mock("viem", async (original) => ({
  ...(await original<typeof import("viem")>()),
  createPublicClient: () => ({ multicall: mocks.owners }),
}));

const owner = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
beforeEach(() => {
  vi.clearAllMocks();
});

describe("Gnars-only marketplace catalogue", () => {
  it("uses keyset pagination and the configured DAO, not a whole-wallet NFT scan", async () => {
    mocks.query.mockResolvedValue({
      tokens: [{ tokenId: "12", image: null, ownerInfo: { owner } }],
    });
    mocks.owners.mockResolvedValue([owner]);
    expect((await getMarketplaceCatalogue(owner, "24")).items[0]).toMatchObject({
      tokenId: "12",
      owner,
    });
    const [query, variables] = mocks.query.mock.calls[0];
    expect(query).toContain("tokenId_lt: $before");
    expect(query).toContain("first: 24");
    expect(query).toContain("owner_not: $zero");
    expect(variables).toEqual({
      dao: DAO_ADDRESSES.token.toLowerCase(),
      zero: "0x0000000000000000000000000000000000000000",
      owner,
      before: "24",
    });
  });
  it("excludes indexed NFTs that the writer no longer owns", async () => {
    mocks.query.mockResolvedValue({
      tokens: [{ tokenId: "12", image: null, ownerInfo: { owner } }],
    });
    mocks.owners.mockResolvedValue([other]);
    expect((await getMarketplaceCatalogue(owner)).items).toEqual([]);
  });
  it("normalizes raw IPFS artwork through the existing gateway helper", async () => {
    mocks.query.mockResolvedValue({
      tokens: [{ tokenId: "12", image: "ipfs://bafy-test/art.png", ownerInfo: { owner } }],
    });
    expect((await getMarketplaceCatalogue()).items[0].image).toBe(
      "https://magic.decentralized-content.com/ipfs/bafy-test/art.png",
    );
  });
  it("throws on malformed indexer data or ownership RPC failure instead of empty success", async () => {
    mocks.query.mockResolvedValueOnce({ errors: ["unavailable"] });
    await expect(getMarketplaceCatalogue()).rejects.toThrow();
    mocks.query.mockResolvedValueOnce({
      tokens: [{ tokenId: "12", image: null, ownerInfo: { owner } }],
    });
    mocks.owners.mockRejectedValueOnce(new Error("RPC unavailable"));
    await expect(getMarketplaceCatalogue(owner)).rejects.toThrow("RPC unavailable");
  });
});
