import { zeroAddress } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getNativeMarketplaceActivity } from "./marketplace-native-activity";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  protocol: "0x1111111111111111111111111111111111111111",
}));
vi.mock("pg", () => ({
  Pool: class {
    async connect() {
      return { query: mocks.query, release: mocks.release };
    }
  },
}));
vi.mock("@/lib/marketplace/routing", () => ({ getGnarsMarketplaceAddress: () => mocks.protocol }));
const collection = `0x${"2".repeat(40)}`;
const hash = `0x${"a".repeat(64)}`;
const tx = `0x${"b".repeat(64)}`;
function event(logIndex = 1, currency: string = zeroAddress) {
  return {
    id: `8453:${mocks.protocol}:${tx}:${logIndex}`,
    chainId: 8453,
    protocolAddress: mocks.protocol,
    blockNumber: "100",
    blockHash: hash,
    transactionHash: tx,
    logIndex,
    timestamp: 1700000000,
    sale: {
      collectionAddress: collection,
      tokenId: "1",
      seller: `0x${"3".repeat(40)}`,
      buyer: `0x${"4".repeat(40)}`,
      payment: { tokenAddress: currency, quantity: "2000000000000000" },
    },
  };
}
function row(value = event()) {
  return {
    event: value,
    block_number: value.blockNumber,
    block_hash: value.blockHash,
    log_index: value.logIndex,
    transaction_hash: value.transactionHash,
  };
}
let checkpoint: {
  start_block: string;
  indexed_through: string | null;
  block_hash: string | null;
  finalized_target: string | null;
};
let events: ReturnType<typeof row>[];
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MARKETPLACE_DATABASE_URL", "postgres://localhost/test");
  checkpoint = {
    start_block: "90",
    indexed_through: "110",
    block_hash: hash,
    finalized_target: "110",
  };
  events = [row()];
  mocks.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes("SELECT start_block")
      ? [checkpoint]
      : sql.includes("SELECT event")
        ? events
        : [],
  }));
});
describe("native marketplace history reader", () => {
  it.each([null, "111"])("refuses incomplete backfill target %s", async (target) => {
    checkpoint.finalized_target = target;
    events = [];
    await expect(getNativeMarketplaceActivity(collection, "1")).rejects.toMatchObject({
      status: 503,
    });
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("SELECT event"))).toBe(false);
  });
  it("reads a repeatable snapshot and emits exact ETH sale price and position", async () => {
    const result = await getNativeMarketplaceActivity(collection, "1");
    expect(result.events[0]).toMatchObject({
      source: "gnars-contract",
      blockNumber: "100",
      logIndex: 1,
      payment: { symbol: "ETH", decimals: 18, quantity: "2000000000000000" },
    });
    expect(result.coverage).toEqual({ startBlock: "90", indexedThrough: "110", blockHash: hash });
    expect(mocks.query.mock.calls[0][0]).toContain("REPEATABLE READ READ ONLY");
    expect(mocks.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(mocks.release).toHaveBeenCalledWith(true);
  });
  it("does not guess decimals of arbitrary payment tokens", async () => {
    events = [row(event(1, collection))];
    expect((await getNativeMarketplaceActivity(collection, "1")).events[0].payment).toBeUndefined();
  });
  it("recognizes Base WETH", async () => {
    events = [row(event(1, "0x4200000000000000000000000000000000000006"))];
    expect((await getNativeMarketplaceActivity(collection, "1")).events[0].payment?.symbol).toBe(
      "WETH",
    );
  });
  it("uses pinned upper bound and exclusive descending position pagination", async () => {
    events = Array.from({ length: 21 }, (_, i) => row(event(29 - i)));
    const result = await getNativeMarketplaceActivity(
      collection,
      "1",
      { blockNumber: "100", logIndex: 30 },
      "105",
    );
    expect(result.events).toHaveLength(20);
    expect(result.nextCursor).toEqual({ blockNumber: "100", logIndex: 10 });
    const query = mocks.query.mock.calls.find(([sql]) => sql.includes("SELECT event"));
    expect(query?.[0]).toContain("(block_number, log_index) <");
    expect(query?.[1]).toEqual([mocks.protocol, collection, "1", "90", "105", "100", 30]);
  });
  it("returns true empty only for initialized coverage", async () => {
    events = [];
    expect((await getNativeMarketplaceActivity(collection, "1")).events).toEqual([]);
  });
  it.each(["uninitialized", "identity", "position", "currency", "bounds", "duplicate", "database"])(
    "fails closed for %s",
    async (kind) => {
      if (kind === "uninitialized") {
        checkpoint.indexed_through = null;
        checkpoint.block_hash = null;
      }
      if (kind === "identity") events[0].event.sale.tokenId = "2";
      if (kind === "position") events[0].block_number = "101";
      if (kind === "currency") events[0].event.sale.payment.quantity = "-1";
      if (kind === "bounds") {
        events[0].event.blockNumber = "111";
        events[0].block_number = "111";
      }
      if (kind === "duplicate") events.push(events[0]);
      if (kind === "database") mocks.query.mockRejectedValue(new Error("secret database"));
      await expect(getNativeMarketplaceActivity(collection, "1")).rejects.toMatchObject({
        status: 503,
        message: "Native marketplace history is unavailable.",
      });
      expect(mocks.release).toHaveBeenCalledWith(true);
    },
  );
  it("rejects invalid request before database", async () => {
    await expect(getNativeMarketplaceActivity(collection, "-1")).rejects.toMatchObject({
      status: 400,
    });
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("rejects a future pinned bound", async () => {
    await expect(
      getNativeMarketplaceActivity(collection, "1", undefined, "111"),
    ).rejects.toMatchObject({ status: 503 });
  });
});
