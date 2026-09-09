import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enforceMarketplaceBudget,
  enforceOpenSeaProviderBudget,
  getMarketplaceOrder,
  listMarketplaceOrders,
  localMarketplaceOffer,
  marketplaceContractStorageReady,
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
  chain: vi.fn(),
  block: vi.fn(),
  multicall: vi.fn(),
  contractReady: vi.fn(),
}));
vi.mock("./marketplace-contract", () => ({ marketplaceContractReady: mocks.contractReady }));
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock("pg", () => ({
  Pool: vi.fn(function () {
    return { query: mocks.query, connect: mocks.connect };
  }),
}));
vi.mock("@/lib/marketplace/seaport", () => ({
  SEAPORT_ADDRESS: "0x0000000000000068F116a894984e2DB1123eB395",
  seaportAbi: [],
  validateListingOnchain: mocks.validate,
  validateListingStructure: mocks.structure,
  getListingStatus: mocks.status,
  getListingOrderHash: mocks.hash,
  getListingPriceWei: () => 100n,
}));
vi.mock("@/services/marketplace-common", async (original) => ({
  ...(await original<typeof import("./marketplace-common")>()),
  marketplaceClient: { getChainId: mocks.chain, getBlock: mocks.block, multicall: mocks.multicall },
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
  vi.stubEnv("NEXT_PUBLIC_GNARS_MARKETPLACE_ADDRESS", "");
  mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
  mocks.structure.mockImplementation((raw) => raw);
  mocks.hash.mockReturnValue(hash);
  mocks.validate.mockResolvedValue({ orderHash: hash });
  mocks.status.mockResolvedValue("active");
  mocks.contractReady.mockResolvedValue(true);
  mocks.chain.mockResolvedValue(8453);
  mocks.block.mockResolvedValue({ number: 123n, timestamp: BigInt(Math.floor(Date.now() / 1000)) });
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

describe("batched marketplace catalogue reconciliation", () => {
  function stored(id: string, options: { fresh?: boolean; tokenId?: string; count?: string } = {}) {
    return {
      id,
      order_hash: hash,
      status: "active",
      checked_at: new Date(Date.now() - (options.fresh ? 1000 : 30000)),
      candidate_count: options.count,
      signed_order: {
        ...listing,
        parameters: {
          ...listing.parameters,
          counter: "0",
          startTime: "1",
          offer: [{ identifierOrCriteria: options.tokenId ?? id }],
        },
      },
    };
  }
  function rows(values: ReturnType<typeof stored>[]) {
    const original = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (sql, ...args) => {
      if (
        sql.includes("ROW_NUMBER()") ||
        sql.trimStart().startsWith("SELECT id, order_hash, signed_order, status, checked_at")
      )
        return { rowCount: values.length, rows: values };
      return original(sql, ...args);
    });
  }
  function successfulReads() {
    return [
      [false, false, 0n, 0n],
      0n,
      seller,
      "0x0000000000000068F116a894984e2DB1123eB395",
      false,
    ].map((result) => ({ status: "success", result }));
  }
  it("uses one pinned-block batch and one update without re-fetching each SQL row", async () => {
    rows([stored("1"), stored("2")]);
    mocks.multicall.mockResolvedValueOnce([...successfulReads(), ...successfulReads()]);
    const result = await listMarketplaceOrders();
    expect(result.offers).toHaveLength(2);
    expect(result.partial).toBe(false);
    expect(mocks.multicall).toHaveBeenCalledOnce();
    expect(mocks.multicall).toHaveBeenCalledWith(
      expect.objectContaining({ blockNumber: 123n, allowFailure: true }),
    );
    expect(mocks.multicall.mock.calls[0][0].contracts).toHaveLength(10);
    expect(
      mocks.query.mock.calls.filter(([sql]) => sql.includes("UPDATE marketplace_orders")),
    ).toHaveLength(1);
    expect(
      mocks.query.mock.calls.some(([sql]) =>
        sql.startsWith("SELECT id, order_hash, signed_order, status FROM"),
      ),
    ).toBe(false);
    expect(mocks.status).not.toHaveBeenCalled();
  });
  it("reuses recently checked rows without issuing another RPC or database write", async () => {
    rows([stored("1", { fresh: true })]);
    expect((await listMarketplaceOrders()).offers).toHaveLength(1);
    expect(mocks.multicall).not.toHaveBeenCalled();
    expect(mocks.block).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("UPDATE marketplace_orders"))).toBe(
      false,
    );
  });
  it("filters native selling pages by seller using a bound SQL parameter", async () => {
    rows([stored("1", { fresh: true })]);
    await listMarketplaceOrders("99", undefined, seller);
    const query = mocks.query.mock.calls.find(([sql]) => sql.includes("AND seller ="))!;
    expect(query[0]).toContain("AND seller = $3");
    expect(query[1]).toEqual([expect.any(Number), "99", seller]);
    expect(query[0]).not.toContain(seller);
  });
  it("keeps verified rows and marks partial when another NFT ownerOf fails", async () => {
    rows([stored("1"), stored("2")]);
    const bad = successfulReads();
    bad[2] = { status: "failure", result: undefined } as never;
    mocks.multicall.mockResolvedValueOnce([...successfulReads(), ...bad]);
    const result = await listMarketplaceOrders();
    expect(result).toMatchObject({ partial: true, offers: [{ tokenId: "1" }] });
    const update = mocks.query.mock.calls.find(([sql]) =>
      sql.includes("UPDATE marketplace_orders"),
    );
    expect(update?.[1][0]).toHaveLength(1);
  });
  it("does not report an empty complete orderbook on a batch RPC failure", async () => {
    rows([stored("1")]);
    mocks.multicall.mockRejectedValueOnce(new Error("RPC unavailable"));
    expect(await listMarketplaceOrders()).toMatchObject({ offers: [], partial: true });
  });
  it("budgets candidates per NFT rather than letting one NFT consume the whole grid", async () => {
    rows([stored("1", { fresh: true, count: "26" }), stored("2", { fresh: true })]);
    const result = await listMarketplaceOrders(undefined, ["1", "2"]);
    expect(result).toMatchObject({ partial: true, nextCursor: null });
    expect(result.offers).toHaveLength(2);
    const query = mocks.query.mock.calls.find(([sql]) => sql.includes("ROW_NUMBER()"))![0];
    expect(query).toContain("PARTITION BY token_id");
    expect(query).not.toContain("LIMIT 24");
  });
  it("does not delete or mark invalid rows when persisting a verified snapshot fails", async () => {
    rows([stored("1")]);
    const original = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (sql, ...args) => {
      if (sql.includes("UPDATE marketplace_orders")) throw new Error("DB unavailable");
      return original(sql, ...args);
    });
    mocks.multicall.mockResolvedValueOnce(successfulReads());
    expect(await listMarketplaceOrders()).toMatchObject({
      partial: true,
      offers: [{ tokenId: "1" }],
    });
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
      source: "gnars",
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

describe("isolated Gnars contract order storage", () => {
  const protocol = "0x3333333333333333333333333333333333333333";
  function configureStoredProtocol(storedProtocol = protocol) {
    vi.stubEnv("NEXT_PUBLIC_GNARS_MARKETPLACE_ADDRESS", protocol);
    const original = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (sql, ...args) => {
      const result = await original(sql, ...args);
      if (
        sql.startsWith("SELECT id, order_hash") &&
        sql.includes("FROM marketplace_contract_orders")
      )
        return {
          ...result,
          rows: result.rows.map((row: object) => ({ ...row, protocol_address: storedProtocol })),
        };
      return result;
    });
  }
  it("keeps legacy ready when no custom deployment or custom table is available", async () => {
    expect(await marketplaceContractStorageReady()).toBe(false);
    expect(await marketplaceStorageReady()).toBe(true);
    configureStoredProtocol();
    const original = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (sql, ...args) => {
      if (sql.includes("marketplace_contract_orders LIMIT 0"))
        throw new Error("missing custom schema");
      return original(sql, ...args);
    });
    expect(await marketplaceContractStorageReady()).toBe(false);
    expect(await marketplaceStorageReady()).toBe(true);
  });
  it("blocks every custom storage path when the deployed runtime is not verified", async () => {
    configureStoredProtocol();
    mocks.contractReady.mockResolvedValue(false);
    expect(await marketplaceContractStorageReady()).toBe(false);
    await expect(saveMarketplaceOrder(listing, "gnars-contract")).rejects.toThrow("unavailable");
    await expect(getMarketplaceOrder(hash, "gnars-contract")).rejects.toThrow("unavailable");
    await expect(reconcileMarketplaceOrder(hash, "gnars-contract")).rejects.toThrow("unavailable");
    await expect(
      listMarketplaceOrders(undefined, undefined, undefined, "gnars-contract"),
    ).rejects.toThrow("unavailable");
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.status).not.toHaveBeenCalled();
  });
  it("requires only status/snapshot update privileges, never permission to rewrite signed terms", async () => {
    configureStoredProtocol();
    expect(await marketplaceContractStorageReady()).toBe(true);
    const permissionSql = mocks.query.mock.calls.find(([sql]) =>
      sql.includes("has_column_privilege"),
    )?.[0];
    expect(permissionSql).toContain("'status', 'UPDATE'");
    expect(permissionSql).toContain("'checked_at', 'UPDATE'");
    expect(permissionSql).not.toContain("'signed_order', 'UPDATE'");
  });
  it("stores custom signatures under their protocol without writing the canonical order table", async () => {
    configureStoredProtocol();
    const offer = await saveMarketplaceOrder(listing, "gnars-contract");
    expect(offer).toMatchObject({
      source: "gnars-contract",
      protocolAddress: protocol,
      id: `gnars-contract:${hash}`,
    });
    expect(mocks.validate).toHaveBeenCalledWith(expect.anything(), listing, {
      requireApproval: true,
      source: "gnars-contract",
    });
    const insert = mocks.query.mock.calls.find(([sql]) =>
      sql.startsWith("INSERT INTO marketplace_contract_orders"),
    )!;
    expect(insert[0]).toContain("ON CONFLICT (chain_id, protocol_address, order_hash)");
    expect(insert[1]).toEqual([
      hash,
      "12",
      seller,
      "100",
      2000000000,
      JSON.stringify(listing),
      protocol,
    ]);
    expect(
      mocks.query.mock.calls.some(([sql]) => sql.startsWith("INSERT INTO marketplace_orders")),
    ).toBe(false);
    expect(localMarketplaceOffer(listing as never).source).toBe("gnars");
  });
  it("scopes hash lookup and chain reconciliation to the configured protocol", async () => {
    configureStoredProtocol();
    await getMarketplaceOrder(hash, "gnars-contract");
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("AND protocol_address = $2"), [
      hash,
      protocol,
    ]);
    await reconcileMarketplaceOrder(hash, "gnars-contract");
    expect(mocks.status).toHaveBeenCalledWith(expect.anything(), listing, {
      source: "gnars-contract",
    });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE marketplace_contract_orders"),
      [hash, "active", protocol],
    );
  });
  it("rejects stored protocol mismatches even if the order hash is identical", async () => {
    configureStoredProtocol("0x4444444444444444444444444444444444444444");
    await expect(getMarketplaceOrder(hash, "gnars-contract")).rejects.toThrow(
      "protocol could not be verified",
    );
  });
  it("uses bound protocol filters with every catalogue filter and custom-only RPC targets", async () => {
    configureStoredProtocol();
    const original = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (sql, ...args) => {
      if (sql.includes("ROW_NUMBER()"))
        return {
          rowCount: 1,
          rows: [
            {
              id: "1",
              order_hash: hash,
              protocol_address: protocol,
              status: "active",
              checked_at: new Date(0),
              signed_order: {
                ...listing,
                parameters: { ...listing.parameters, startTime: "1", counter: "0" },
              },
            },
          ],
        };
      return original(sql, ...args);
    });
    mocks.multicall.mockResolvedValue(
      [[false, false, 0n, 0n], 0n, seller, protocol, false].map((result) => ({
        status: "success",
        result,
      })),
    );
    const result = await listMarketplaceOrders("99", ["12"], seller, "gnars-contract");
    expect(result.offers[0]?.offer.protocolAddress).toBe(protocol);
    const query = mocks.query.mock.calls.find(([sql]) => sql.includes("ROW_NUMBER()"))!;
    expect(query[0]).toContain("AND protocol_address = $5");
    expect(query[1]).toEqual([expect.any(Number), "99", ["12"], seller, protocol]);
    const calls = mocks.multicall.mock.calls[0][0].contracts;
    expect(calls[0].address).toBe(protocol);
    expect(calls[1].address).toBe(protocol);
    expect(calls[4].args).toEqual([seller, protocol]);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("AND orders.protocol_address = $3"),
      [[hash], ["active"], protocol],
    );
  });
  it("fails closed on custom operations without a configured target", async () => {
    await expect(saveMarketplaceOrder(listing, "gnars-contract")).rejects.toThrow("not configured");
    await expect(getMarketplaceOrder(hash, "gnars-contract")).rejects.toThrow("not configured");
    await expect(
      listMarketplaceOrders(undefined, undefined, undefined, "gnars-contract"),
    ).rejects.toThrow("not configured");
    expect(mocks.query).not.toHaveBeenCalled();
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
  it("budgets OpenSea reads, fulfillment and posting separately across instances", async () => {
    await enforceOpenSeaProviderBudget("read");
    await enforceOpenSeaProviderBudget("fulfillment");
    await enforceOpenSeaProviderBudget("posting");
    const budgets = mocks.query.mock.calls.filter(([sql]) =>
      sql.includes("INSERT INTO marketplace_rate_limits"),
    );
    expect(budgets).toHaveLength(3);
    expect(budgets[0][1][2]).toBe(30);
    expect(budgets[1][1][2]).toBe(15);
    expect(budgets[2][1][2]).toBe(15);
    expect(new Set(budgets.map(([, parameters]) => parameters[0])).size).toBe(3);
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
    await enforceOpenSeaProviderBudget("posting");
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
