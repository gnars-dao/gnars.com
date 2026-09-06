import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enforceMarketplaceBudget,
  enforceOpenSeaProviderBudget,
  getMarketplaceOrder,
  marketplaceStorageReady,
  reconcileMarketplaceOrder,
  saveMarketplaceOrder,
} from "./marketplace-orders";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  release: vi.fn(),
  validate: vi.fn(),
  structure: vi.fn(),
  status: vi.fn(),
  hash: vi.fn(),
}));
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock("pg", () => ({
  Pool: vi.fn(function () {
    return { query: mocks.query, connect: mocks.connect };
  }),
}));
vi.mock("@/lib/marketplace/seaport", () => ({
  SEAPORT_ADDRESS: "0x0000000000000068F116a894984e2DB1123eB395",
  validateListingOnchain: mocks.validate,
  validateListingStructure: mocks.structure,
  getListingStatus: mocks.status,
  getListingOrderHash: mocks.hash,
  getListingPriceWei: () => 100n,
}));

const hash = `0x${"a".repeat(64)}`;
const seller = "0x1111111111111111111111111111111111111111";
const listing = {
  parameters: { offerer: seller, offer: [{ identifierOrCriteria: "12" }], endTime: "2000000000" },
  signature: "0xabcd",
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MARKETPLACE_DATABASE_URL", "postgres://localhost/test-only");
  mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
  mocks.structure.mockImplementation((raw) => raw);
  mocks.hash.mockReturnValue(hash);
  mocks.validate.mockResolvedValue({ orderHash: hash });
  mocks.status.mockResolvedValue("active");
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("AS writable")) return { rowCount: 1, rows: [{ writable: true }] };
    if (sql.includes("SELECT count(*)")) return { rowCount: 1, rows: [{ count: "0" }] };
    if (sql.startsWith("SELECT order_hash FROM")) return { rowCount: 0, rows: [] };
    if (sql.startsWith("SELECT id, order_hash"))
      return {
        rowCount: 1,
        rows: [{ id: "1", order_hash: hash, signed_order: listing, status: "active" }],
      };
    return { rowCount: 1, rows: [] };
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("durable marketplace orders", () => {
  it("requires both order and budget tables for readiness", async () => {
    mocks.query.mockRejectedValueOnce(new Error("missing schema"));
    expect(await marketplaceStorageReady()).toBe(false);
    expect(await marketplaceStorageReady()).toBe(true);
    expect(
      mocks.query.mock.calls.some(([sql]) => sql.includes("marketplace_rate_limits LIMIT 0")),
    ).toBe(true);
  });
  it("does not advertise trading readiness for a read-only database role", async () => {
    const original = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (sql, ...args) =>
      sql.includes("AS writable")
        ? { rowCount: 1, rows: [{ writable: false }] }
        : original(sql, ...args),
    );
    expect(await marketplaceStorageReady()).toBe(false);
  });
  it("verifies signer/ownership/approval before inserting and serializes a seller quota", async () => {
    await saveMarketplaceOrder(listing);
    expect(mocks.validate).toHaveBeenCalledWith(expect.anything(), listing, {
      requireApproval: true,
    });
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("pg_advisory_xact_lock"))).toBe(
      true,
    );
    const insert = mocks.query.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO marketplace_orders"),
    );
    expect(insert?.[1]).toEqual([hash, "12", seller, "100", 2000000000, JSON.stringify(listing)]);
    expect(mocks.release).toHaveBeenCalled();
  });
  it("does not insert a rejected signature or an order with invalid chain state", async () => {
    mocks.validate.mockRejectedValueOnce(new Error("Invalid signature"));
    await expect(saveMarketplaceOrder(listing)).rejects.toThrow("Invalid signature");
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("does not overwrite an already stored order hash on replay", async () => {
    const original = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (sql, ...args) =>
      sql.startsWith("SELECT order_hash FROM")
        ? { rowCount: 1, rows: [{ order_hash: hash }] }
        : original(sql, ...args),
    );
    await saveMarketplaceOrder(listing);
    expect(
      mocks.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO marketplace_orders")),
    ).toBe(false);
  });
  it("rolls back when a seller has 25 active listings", async () => {
    const original = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (sql, ...args) =>
      sql.includes("SELECT count(*)")
        ? { rowCount: 1, rows: [{ count: "25" }] }
        : original(sql, ...args),
    );
    await expect(saveMarketplaceOrder(listing)).rejects.toMatchObject({ status: 429 });
    expect(mocks.query).toHaveBeenCalledWith("ROLLBACK");
  });
  it("normalizes hash lookups and verifies stored order identity", async () => {
    await getMarketplaceOrder(`0x${"A".repeat(64)}`);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("WHERE chain_id = 8453"), [
      hash,
    ]);
    mocks.hash.mockReturnValue(`0x${"b".repeat(64)}`);
    await expect(getMarketplaceOrder(hash)).rejects.toThrow("could not be verified");
  });
  it("stores only chain-derived reconciliation status and propagates RPC failure", async () => {
    mocks.status.mockResolvedValueOnce("cancelled");
    expect(await reconcileMarketplaceOrder(hash)).toMatchObject({ status: "cancelled" });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE marketplace_orders"), [
      hash,
      "cancelled",
    ]);
    mocks.query.mockClear();
    mocks.status.mockRejectedValueOnce(new Error("RPC unavailable"));
    await expect(reconcileMarketplaceOrder(hash)).rejects.toThrow("RPC unavailable");
    expect(mocks.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false);
  });
});

describe("distributed paid-operation budgets", () => {
  it("atomically consumes IP and global buckets without storing raw IPs", async () => {
    await enforceMarketplaceBudget(
      new Request("https://gnars.com", { headers: { "x-vercel-forwarded-for": "192.0.2.1" } }),
      "fulfillment",
    );
    const budgets = mocks.query.mock.calls.filter(([sql]) =>
      sql.includes("INSERT INTO marketplace_rate_limits"),
    );
    expect(budgets).toHaveLength(2);
    expect(budgets[0][0]).toContain("WHERE marketplace_rate_limits.hits < $3");
    expect(budgets[0][1][0]).toMatch(/^[a-f0-9]{64}$/);
    expect(budgets[0][1][2]).toBe(20);
    expect(budgets[1][1][2]).toBe(40);
    expect(JSON.stringify(budgets)).not.toContain("192.0.2.1");
  });
  it("rejects exhausted IP budget before spending the global budget", async () => {
    const original = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (sql, ...args) =>
      sql.includes("INSERT INTO marketplace_rate_limits")
        ? { rowCount: 0, rows: [] }
        : original(sql, ...args),
    );
    await expect(
      enforceMarketplaceBudget(new Request("https://gnars.com"), "create"),
    ).rejects.toMatchObject({ status: 429 });
    expect(
      mocks.query.mock.calls.filter(([sql]) => sql.includes("INSERT INTO marketplace_rate_limits")),
    ).toHaveLength(1);
  });
  it("budgets actual OpenSea reads separately from fulfillment across instances", async () => {
    await enforceOpenSeaProviderBudget("read");
    await enforceOpenSeaProviderBudget("fulfillment");
    const budgets = mocks.query.mock.calls.filter(([sql]) =>
      sql.includes("INSERT INTO marketplace_rate_limits"),
    );
    expect(budgets).toHaveLength(2);
    expect(budgets[0][1][2]).toBe(30);
    expect(budgets[1][1][2]).toBe(15);
    expect(budgets[0][1][0]).not.toBe(budgets[1][1][0]);
  });
  it("does not make an existing database without marketplace tables block OpenSea", async () => {
    mocks.query.mockRejectedValueOnce(new Error("marketplace schema is missing"));
    await expect(enforceOpenSeaProviderBudget("read")).resolves.toBeUndefined();
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO"))).toBe(false);
  });
  it("fails closed if consuming a ready distributed budget fails", async () => {
    const original = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (sql, ...args) => {
      if (sql.includes("INSERT INTO marketplace_rate_limits")) throw new Error("database offline");
      return original(sql, ...args);
    });
    await expect(enforceOpenSeaProviderBudget("read")).rejects.toThrow("database offline");
  });
  it("permits local-only read protection when no database is configured", async () => {
    for (const key of [
      "MARKETPLACE_DATABASE_URL",
      "ROUNDS_DATABASE_URL",
      "DATABASE_PUBLIC_URL",
      "DATABASE_URL",
    ])
      vi.stubEnv(key, "");
    await enforceOpenSeaProviderBudget("read");
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
