import { beforeEach, describe, expect, it, vi } from "vitest";
import { DAO_ADDRESSES } from "@/lib/config";
import { getMarketplaceTraitFacets, getMarketplaceTraitSnapshot } from "./marketplace-trait-index";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("pg", () => ({
  Pool: class {
    query = mocks.query;
  },
}));
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
const hash = `0x${"a".repeat(64)}`;
function snapshot() {
  return {
    version: 1,
    chainId: 8453,
    collection: DAO_ADDRESSES.token.toLowerCase(),
    blockNumber: "123",
    blockHash: hash,
    expectedCount: 2,
    cursor: "1",
    enumerated: true,
    entries: [
      {
        tokenId: "2",
        traits: [
          { type: "Z", value: "B" },
          { type: "A", value: "X" },
          { type: "A", value: "X" },
        ],
      },
      {
        tokenId: "1",
        traits: [
          { type: "Z", value: "A" },
          { type: "A", value: "X" },
        ],
      },
    ],
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MARKETPLACE_DATABASE_URL", "postgres://localhost/test");
  mocks.query.mockResolvedValue({
    rows: [{ snapshot: snapshot(), block_hash: hash, block_number: "123" }],
  });
});
describe("published marketplace traits", () => {
  it("counts tokens once per value and sorts deterministically", async () => {
    expect(await getMarketplaceTraitFacets()).toEqual({
      snapshotId: hash,
      blockNumber: "123",
      collectionAddress: DAO_ADDRESSES.token.toLowerCase(),
      total: 2,
      traits: [
        { type: "A", values: [{ value: "X", count: 2 }] },
        {
          type: "Z",
          values: [
            { value: "A", count: 1 },
            { value: "B", count: 1 },
          ],
        },
      ],
    });
    expect(mocks.query.mock.calls[0][0]).toContain("ORDER BY block_number DESC");
  });
  it("pins historical reads to their exact hash", async () => {
    await getMarketplaceTraitSnapshot(hash);
    expect(mocks.query.mock.calls[0][1]).toEqual([DAO_ADDRESSES.token.toLowerCase(), hash]);
    expect(mocks.query.mock.calls[0][0]).toContain("AND block_hash = $2");
  });
  it("rejects malformed snapshot ids before querying", () => {
    expect(() => getMarketplaceTraitSnapshot("latest")).toThrow();
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it.each([
    "missing",
    "incomplete",
    "wrong-collection",
    "wrong-hash",
    "wrong-block",
    "supply",
    "duplicate",
    "database",
  ])("fails explicitly for %s", async (kind) => {
    const index = snapshot();
    if (kind === "incomplete") index.enumerated = false;
    if (kind === "wrong-collection") index.collection = `0x${"1".repeat(40)}`;
    if (kind === "wrong-hash") index.blockHash = `0x${"b".repeat(64)}`;
    if (kind === "wrong-block") index.blockNumber = "124";
    if (kind === "supply") index.expectedCount = 3;
    if (kind === "duplicate") index.entries[1].tokenId = "2";
    mocks.query.mockResolvedValue({
      rows: kind === "missing" ? [] : [{ snapshot: index, block_hash: hash, block_number: "123" }],
    });
    if (kind === "database") mocks.query.mockRejectedValue(new Error("private database URL"));
    await expect(getMarketplaceTraitSnapshot()).rejects.toMatchObject({
      status: 503,
      message: "Marketplace trait snapshot is unavailable.",
    });
  });
});
