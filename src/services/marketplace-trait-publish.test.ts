import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAO_ADDRESSES } from "@/lib/config";
import { publishMarketplaceTraits } from "../../scripts/marketplace-trait-publish";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  pool: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
  end: vi.fn(),
  getChainId: vi.fn(),
  getBlock: vi.fn(),
  readContract: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("pg", () => ({
  Pool: class {
    constructor(options: unknown) {
      mocks.pool(options);
    }
    connect = async () => ({ query: mocks.query, release: mocks.release });
    end = mocks.end;
  },
}));
vi.mock("viem", async (original) => ({
  ...(await original<typeof import("viem")>()),
  createPublicClient: () => mocks,
}));
const hash = `0x${"a".repeat(64)}`;
const snapshot = () => ({
  version: 1,
  chainId: 8453,
  collection: DAO_ADDRESSES.token.toLowerCase(),
  blockNumber: "100",
  blockHash: hash,
  expectedCount: 1,
  cursor: "1",
  enumerated: true,
  entries: [{ tokenId: "1", traits: [{ type: "Head", value: "Mirror" }] }],
});
const argv = process.argv;
beforeEach(() => {
  vi.clearAllMocks();
  process.argv = ["node", "script", "snapshot.json"];
  vi.stubEnv("MARKETPLACE_INDEXER_DATABASE_URL", "postgres://localhost/indexer");
  vi.stubEnv("MARKETPLACE_MIGRATION_DATABASE_URL", "");
  vi.stubEnv("BASE_RPC", "https://example.com");
  mocks.readFile.mockResolvedValue(JSON.stringify(snapshot()));
  mocks.getChainId.mockResolvedValue(8453);
  mocks.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber?: bigint }) => ({
    number: blockNumber ?? 200n,
    hash,
  }));
  mocks.readContract.mockResolvedValue(1n);
  mocks.query.mockResolvedValue({ rows: [{ identical: true }] });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  process.argv = argv;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("trait snapshot publication", () => {
  it("publishes atomically with scoped credentials and verifies identical content", async () => {
    vi.stubEnv("MARKETPLACE_MIGRATION_DATABASE_URL", "postgres://localhost/admin");
    await publishMarketplaceTraits();
    expect(mocks.pool).toHaveBeenCalledWith(
      expect.objectContaining({ connectionString: "postgres://localhost/indexer" }),
    );
    const sql = mocks.query.mock.calls.map(([query]) => query as string);
    expect(sql[0]).toBe("BEGIN");
    expect(sql.some((query) => query.includes("ON CONFLICT DO NOTHING"))).toBe(true);
    expect(sql.some((query) => query.includes("SELECT snapshot ="))).toBe(true);
    expect(sql.at(-1)).toBe("COMMIT");
    expect(mocks.release).toHaveBeenCalledWith(true);
    expect(mocks.end).toHaveBeenCalled();
  });
  it("rejects incomplete metadata without opening the database", async () => {
    mocks.readFile.mockResolvedValue(
      JSON.stringify({ ...snapshot(), entries: [{ tokenId: "1", traits: null }] }),
    );
    await expect(publishMarketplaceTraits()).rejects.toThrow("Complete Gnars snapshot");
    expect(mocks.pool).not.toHaveBeenCalled();
  });
  it("rejects an unfinished enumeration without replacing the current snapshot", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ ...snapshot(), enumerated: false }));
    await expect(publishMarketplaceTraits()).rejects.toThrow("Complete Gnars snapshot");
    expect(mocks.pool).not.toHaveBeenCalled();
  });
  it("rejects a reorg or unfinalized block", async () => {
    mocks.getBlock.mockResolvedValue({ number: 90n, hash: `0x${"b".repeat(64)}` });
    await expect(publishMarketplaceTraits()).rejects.toThrow("canonical and finalized");
    expect(mocks.pool).not.toHaveBeenCalled();
  });
  it("rejects mismatched onchain supply", async () => {
    mocks.readContract.mockResolvedValue(2n);
    await expect(publishMarketplaceTraits()).rejects.toThrow("supply or canonical");
    expect(mocks.pool).not.toHaveBeenCalled();
  });
  it("destroys the connection without committing when immutable content differs", async () => {
    mocks.query.mockResolvedValue({ rows: [{ identical: false }] });
    await expect(publishMarketplaceTraits()).rejects.toThrow("snapshot differs");
    expect(mocks.query).not.toHaveBeenCalledWith("COMMIT");
    expect(mocks.release).toHaveBeenCalledWith(true);
    expect(mocks.end).toHaveBeenCalled();
  });
  it("never falls back to website runtime credentials", async () => {
    vi.stubEnv("MARKETPLACE_INDEXER_DATABASE_URL", "");
    vi.stubEnv("MARKETPLACE_DATABASE_URL", "postgres://localhost/runtime");
    await expect(publishMarketplaceTraits()).rejects.toThrow("Explicit writer");
    expect(mocks.pool).not.toHaveBeenCalled();
  });
});
