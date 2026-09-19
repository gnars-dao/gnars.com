import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncNativeHistoryMain } from "../../scripts/marketplace-history-sync";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  end: vi.fn(),
  scan: vi.fn(),
  getChainId: vi.fn(),
  getTransactionReceipt: vi.fn(),
  getBlock: vi.fn(),
}));
vi.mock("pg", () => ({
  Pool: class {
    connect = async () => ({ query: mocks.query, release: mocks.release });
    end = mocks.end;
  },
}));
vi.mock("viem", async (original) => ({
  ...(await original<typeof import("viem")>()),
  createPublicClient: () => mocks,
}));
vi.mock("@/lib/marketplace/native-history-scan", async (original) => ({
  ...(await original<typeof import("@/lib/marketplace/native-history-scan")>()),
  scanNativeHistoryRange: mocks.scan,
}));
vi.mock("@/lib/marketplace/routing", () => ({
  getGnarsMarketplaceAddress: () => `0x${"1".repeat(40)}`,
}));
const protocol = `0x${"1".repeat(40)}`,
  hash = `0x${"a".repeat(64)}`,
  tx = `0x${"b".repeat(64)}`;
const argv = process.argv;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MARKETPLACE_MIGRATION_DATABASE_URL", "postgres://localhost/test");
  vi.stubEnv("BASE_RPC", "https://example.com");
  process.argv = ["node", "script", tx, "1", "100"];
  mocks.getChainId.mockResolvedValue(8453);
  mocks.getTransactionReceipt.mockResolvedValue({
    status: "success",
    contractAddress: protocol,
    blockNumber: 90n,
    blockHash: hash,
  });
  mocks.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber?: bigint }) => ({
    number: blockNumber ?? 200n,
    hash,
    timestamp: 1700000000n,
  }));
  mocks.query.mockImplementation(async (sql: string) => ({
    rowCount: 1,
    rows: sql.includes("pg_try_advisory_lock")
      ? [{ locked: true }]
      : sql.includes("SELECT deployment_hash")
        ? [{ deployment_hash: tx, start_block: "90", indexed_through: null, block_hash: null }]
        : [],
  }));
  mocks.scan.mockResolvedValue({
    checkpoint: {
      version: 1,
      chainId: 8453,
      protocolAddress: protocol,
      startBlock: "90",
      indexedThrough: "189",
      blockHash: hash,
    },
    events: [
      {
        protocolAddress: protocol,
        transactionHash: tx,
        logIndex: 1,
        blockNumber: "100",
        blockHash: hash,
        sale: null,
      },
    ],
    finalizedTarget: "200",
    caughtUp: false,
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  process.argv = argv;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("administrative native history ingestion", () => {
  it("commits raw events and checkpoint in same transaction after finalized RPC scan", async () => {
    await syncNativeHistoryMain();
    const calls = mocks.query.mock.calls.map(([sql]) => sql as string);
    expect(calls.indexOf("BEGIN")).toBeLessThan(calls.findIndex((sql) => sql.startsWith("UPDATE")));
    expect(
      calls.findIndex((sql) => sql.includes("INSERT INTO public.marketplace_history_events")),
    ).toBeLessThan(calls.indexOf("COMMIT"));
    expect(calls.find((sql) => sql.startsWith("UPDATE"))).toContain("IS NOT DISTINCT FROM");
    const update = mocks.query.mock.calls.find(([sql]) => sql.startsWith("UPDATE"));
    expect(update?.[0]).toContain("finalized_target=$8");
    expect(update?.[1][7]).toBe("200");
    expect(mocks.scan.mock.calls[0][0].indexedThrough).toBeNull();
    expect(mocks.release).toHaveBeenCalledWith(true);
    expect(mocks.end).toHaveBeenCalled();
  });
  it("rolls back checkpoint when event insert fails", async () => {
    const implementation = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (sql, ...args) => {
      if (sql.includes("INSERT INTO public.marketplace_history_events"))
        throw new Error("insert failed");
      return implementation(sql, ...args);
    });
    await expect(syncNativeHistoryMain()).rejects.toThrow("insert failed");
    expect(mocks.query).toHaveBeenCalledWith("ROLLBACK");
    expect(mocks.query).not.toHaveBeenCalledWith("COMMIT");
  });
  it("does not advance on malformed or unavailable RPC range", async () => {
    mocks.scan.mockRejectedValue(new Error("bad logs"));
    await expect(syncNativeHistoryMain()).rejects.toThrow("bad logs");
    expect(mocks.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false);
  });
  it("rejects concurrent compare-and-swap changes", async () => {
    const implementation = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (sql, ...args) =>
      sql.startsWith("UPDATE") ? { rowCount: 0, rows: [] } : implementation(sql, ...args),
    );
    await expect(syncNativeHistoryMain()).rejects.toThrow("Concurrent checkpoint change");
    expect(mocks.query).toHaveBeenCalledWith("ROLLBACK");
  });
  it("does not scan when another writer holds lock", async () => {
    mocks.query.mockResolvedValue({ rows: [{ locked: false }] });
    await expect(syncNativeHistoryMain()).rejects.toThrow("Another history writer");
    expect(mocks.scan).not.toHaveBeenCalled();
  });
  it("requires explicit writer credentials", async () => {
    vi.stubEnv("MARKETPLACE_MIGRATION_DATABASE_URL", "");
    vi.stubEnv("MARKETPLACE_DATABASE_URL", "postgres://localhost/runtime");
    await expect(syncNativeHistoryMain()).rejects.toThrow("Explicit administrative");
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("rejects deployment for a different contract", async () => {
    mocks.getTransactionReceipt.mockResolvedValue({
      status: "success",
      contractAddress: `0x${"2".repeat(40)}`,
    });
    await expect(syncNativeHistoryMain()).rejects.toThrow("Wrong deployment");
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
