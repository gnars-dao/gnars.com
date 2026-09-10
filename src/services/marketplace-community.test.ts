import { zeroAddress, zeroHash, type Address } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILDER_CODE, DAO_ADDRESSES } from "@/lib/config";
import { communityCommentPayload } from "@/lib/marketplace/community-comment";
import { COMMUNITY_FEE_RECIPIENT } from "@/lib/marketplace/community-policy";
import { getListingOrderHash, type SignedListing } from "@/lib/marketplace/seaport";
import { RequestSecurityError } from "@/lib/server/request-security";
import {
  communityMarketplaceReady,
  communityModerationSchema,
  getCommunityEligibility,
  getCommunityOrder,
  getCommunityToken,
  isCommunityModerator,
  listCommunityManagedOrders,
  listCommunityMarketplace,
  listCommunityModeration,
  moderateCommunityOrder,
  prepareCommunityFulfillment,
  publishCommunityOrder,
  quoteCommunityListing,
  reconcileCommunityOrder,
} from "./marketplace-community";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  release: vi.fn(),
  ready: vi.fn(),
  chain: vi.fn(),
  code: vi.fn(),
  read: vi.fn(),
  block: vi.fn(),
  multicall: vi.fn(),
  call: vi.fn(),
  validate: vi.fn(),
  royalty: vi.fn(),
  status: vi.fn(),
  authorize: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock("pg", () => ({
  Pool: vi.fn(function () {
    return { query: mocks.query, connect: mocks.connect };
  }),
}));
vi.mock("@/services/marketplace-orders", () => ({ marketplaceContractStorageReady: mocks.ready }));
vi.mock("@/services/marketplace-common", async (original) => ({
  ...(await original<typeof import("./marketplace-common")>()),
  marketplaceClient: {
    getChainId: mocks.chain,
    getCode: mocks.code,
    readContract: mocks.read,
    getBlock: mocks.block,
    multicall: mocks.multicall,
    call: mocks.call,
  },
}));
vi.mock("@/lib/marketplace/seaport", async (original) => ({
  ...(await original<typeof import("@/lib/marketplace/seaport")>()),
  validateListingOnchain: mocks.validate,
  getListingRoyalty: mocks.royalty,
  getListingStatus: mocks.status,
}));
vi.mock("@/lib/server/request-security", async (original) => ({
  ...(await original<typeof import("@/lib/server/request-security")>()),
  verifyWalletAuthorization: mocks.authorize,
}));

const seller = "0x1111111111111111111111111111111111111111" as Address;
const buyer = "0x2222222222222222222222222222222222222222" as Address;
const protocol = "0x3333333333333333333333333333333333333333" as Address;
const collection = "0x4444444444444444444444444444444444444444" as Address;
const otherCollection = "0x5555555555555555555555555555555555555555" as Address;
const policy = { basisPoints: 100, recipient: COMMUNITY_FEE_RECIPIENT };
function listing(address = collection): SignedListing {
  return {
    parameters: {
      offerer: seller,
      zone: zeroAddress,
      offer: [
        {
          itemType: 2,
          token: address,
          identifierOrCriteria: "12",
          startAmount: "1",
          endAmount: "1",
        },
      ],
      consideration: [
        { recipient: seller, amount: "9900" },
        { recipient: COMMUNITY_FEE_RECIPIENT, amount: "100" },
      ].map(({ recipient, amount }) => ({
        itemType: 0,
        token: zeroAddress,
        identifierOrCriteria: "0",
        startAmount: amount,
        endAmount: amount,
        recipient,
      })),
      orderType: 0,
      startTime: String(Math.floor(Date.now() / 1000) - 30),
      endTime: String(Math.floor(Date.now() / 1000) + 86400),
      zoneHash: zeroHash,
      salt: "12",
      conduitKey: zeroHash,
      counter: "0",
    },
    signature: "0xabcd",
  };
}
function row(address = collection, listingComment?: string) {
  const signed = listing(address);
  return {
    id: "1",
    protocol_address: protocol,
    collection_address: address,
    order_hash: getListingOrderHash(signed.parameters),
    token_id: "12",
    seller,
    signed_order: signed,
    fee_policy: policy,
    metadata: {
      ...(listingComment !== undefined ? { listingComment } : {}),
      name: "Community #12",
      collectionName: "Community",
      image: "https://example.com/nft.png",
    },
    status: "active",
    hidden: false,
    moderation_revision: 0,
    checked_at: new Date(),
  };
}
let records: ReturnType<typeof row>[];
beforeEach(() => {
  vi.clearAllMocks();
  records = [];
  vi.stubEnv("MARKETPLACE_DATABASE_URL", "postgres://localhost/test-only");
  vi.stubEnv("NEXT_PUBLIC_GNARS_MARKETPLACE_ADDRESS", protocol);
  vi.stubEnv("MARKETPLACE_COMMUNITY_FEE_BPS", "100");
  vi.stubEnv("MARKETPLACE_COMMUNITY_ADMIN_ADDRESSES", "");
  vi.stubEnv("ALCHEMY_API_KEY", "test-only");
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.ready.mockResolvedValue(true);
  mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
  mocks.chain.mockResolvedValue(8453);
  mocks.code.mockResolvedValue("0x1234");
  mocks.read.mockImplementation(
    async ({ functionName }) =>
      ({ balanceOf: 6n, ownerOf: seller, supportsInterface: true })[functionName as string],
  );
  mocks.block.mockResolvedValue({ number: 100n, timestamp: BigInt(Math.floor(Date.now() / 1000)) });
  mocks.call.mockResolvedValue({ data: "0x" });
  mocks.royalty.mockResolvedValue({ amount: 0n, recipient: zeroAddress });
  mocks.validate.mockImplementation(async (_client, value: SignedListing) => ({
    orderHash: getListingOrderHash(value.parameters),
  }));
  mocks.status.mockResolvedValue("cancelled");
  mocks.authorize.mockResolvedValue(seller);
  mocks.fetch.mockImplementation(async () =>
    Response.json({
      tokenId: "12",
      name: "Community #12",
      contract: { address: collection, name: "Community" },
      image: { cachedUrl: "https://example.com/nft.png" },
    }),
  );
  mocks.query.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.includes("AS ready")) return { rows: [{ ready: true }], rowCount: 1 };
    if (sql.includes("LIMIT 0")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT *")) return { rows: records, rowCount: records.length };
    if (sql.includes("SELECT count(*)")) return { rows: [{ count: "0" }], rowCount: 1 };
    if (sql.startsWith("INSERT INTO public.marketplace_community_orders"))
      return {
        rows: [
          { ...row(), metadata: values?.[9] ? JSON.parse(String(values[9])) : row().metadata },
        ],
        rowCount: 1,
      };
    return { rows: [], rowCount: 1 };
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("community eligibility and readiness", () => {
  it.each([5n, 6n])("requires six Gnars, not five (%s)", async (balance) => {
    mocks.read.mockResolvedValue(balance);
    const result = await getCommunityEligibility(seller);
    expect(result).toMatchObject({
      owner: seller,
      balance: String(balance),
      minimum: 6,
      eligible: balance >= 6n,
      feeBps: 100,
    });
  });
  it("fails closed on wrong-chain and RPC failures", async () => {
    mocks.chain.mockResolvedValue(1);
    await expect(getCommunityEligibility(seller)).rejects.toThrow("not on Base");
    mocks.chain.mockResolvedValue(8453);
    mocks.read.mockRejectedValue(new Error("RPC down"));
    await expect(getCommunityEligibility(seller)).rejects.toThrow("RPC down");
  });
  it("does not invent a fee or moderator", async () => {
    vi.stubEnv("MARKETPLACE_COMMUNITY_FEE_BPS", "");
    expect(await getCommunityEligibility(seller)).toMatchObject({
      feeBps: null,
      canModerate: false,
    });
    await expect(
      quoteCommunityListing({ collectionAddress: collection, tokenId: "12", priceWei: "10000" }),
    ).rejects.toThrow("fee is not configured");
  });
  it("requires all configured admin addresses to be valid", () => {
    expect(isCommunityModerator(seller)).toBe(false);
    vi.stubEnv("MARKETPLACE_COMMUNITY_ADMIN_ADDRESSES", seller);
    expect(isCommunityModerator(seller)).toBe(true);
    vi.stubEnv("MARKETPLACE_COMMUNITY_ADMIN_ADDRESSES", `${seller},invalid`);
    expect(isCommunityModerator(seller)).toBe(false);
  });
  it("requires verified deployment and moderation privileges", async () => {
    expect(await communityMarketplaceReady()).toBe(true);
    const sql = mocks.query.mock.calls.find(([value]) => value.includes("AS ready"))![0];
    expect(sql).toContain("'public.marketplace_community_moderation', 'INSERT'");
    expect(sql).toContain("'moderation_revision', 'UPDATE'");
    mocks.ready.mockResolvedValue(false);
    expect(await communityMarketplaceReady()).toBe(false);
  });
});

describe("community publication", () => {
  it("authenticates an optional comment against the seller and exact signed order", async () => {
    const signed = listing();
    const authorization = { signature: "0x12", walletAddress: seller };
    const offer = await publishCommunityOrder(signed, {
      listingComment: "  My favorite collectible.  ",
      authorization,
    });
    expect(offer.listingComment).toBe("My favorite collectible.");
    expect(mocks.authorize).toHaveBeenCalledExactlyOnceWith({
      authorization,
      method: "POST",
      path: "/api/marketplace/community/orders",
      payload: communityCommentPayload(
        getListingOrderHash(signed.parameters),
        "My favorite collectible.",
      ),
    });
    const insert = mocks.query.mock.calls.find(([sql]) =>
      sql.startsWith("INSERT INTO public.marketplace_community_orders"),
    )!;
    expect(JSON.parse(insert[1][9])).toMatchObject({
      listingComment: "My favorite collectible.",
      listingCommentAuthorization: authorization,
    });
    expect(JSON.parse(insert[1][7])).toEqual(signed);
    expect(offer).not.toHaveProperty("listingCommentAuthorization");
  });
  it("rejects comments without valid authorization or signed by another wallet", async () => {
    mocks.authorize.mockRejectedValueOnce(
      new RequestSecurityError(401, "Signed wallet request is required."),
    );
    await expect(
      publishCommunityOrder(listing(), { listingComment: "Test" }),
    ).rejects.toMatchObject({ status: 401 });
    mocks.authorize.mockResolvedValueOnce(buyer);
    await expect(
      publishCommunityOrder(listing(), { listingComment: "Test", authorization: {} }),
    ).rejects.toMatchObject({ status: 403 });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it.each(["", " ", "x".repeat(281), "invalid\u0000text", 42])(
    "rejects invalid listing comments before persistence",
    async (listingComment) => {
      await expect(
        publishCommunityOrder(listing(), { listingComment, authorization: {} }),
      ).rejects.toMatchObject({ status: 400 });
      expect(mocks.authorize).not.toHaveBeenCalled();
      expect(mocks.connect).not.toHaveBeenCalled();
    },
  );
  it("recovers immutable comments without rewriting them or requiring a fresh signature", async () => {
    records = [row(collection, "Original seller comment")];
    expect(
      (
        await publishCommunityOrder(records[0].signed_order, {
          listingComment: "Original seller comment",
        })
      ).listingComment,
    ).toBe("Original seller comment");
    expect((await publishCommunityOrder(records[0].signed_order)).listingComment).toBe(
      "Original seller comment",
    );
    await expect(
      publishCommunityOrder(records[0].signed_order, { listingComment: "Replacement" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("does not add a comment retrospectively to a legacy signed order", async () => {
    records = [row()];
    await expect(
      publishCommunityOrder(records[0].signed_order, {
        listingComment: "New text",
        authorization: {},
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("does not overwrite a different comment inserted concurrently for the same order", async () => {
    const query = mocks.query.getMockImplementation()!;
    let reads = 0;
    mocks.query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.startsWith("SELECT *") && ++reads === 2)
        return { rows: [row(collection, "First comment")], rowCount: 1 };
      return query(sql, values);
    });
    await expect(
      publishCommunityOrder(listing(), { listingComment: "Another comment", authorization: {} }),
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.query).toHaveBeenCalledWith("ROLLBACK");
    expect(
      mocks.query.mock.calls.some(([sql]) =>
        sql.startsWith("INSERT INTO public.marketplace_community_orders"),
      ),
    ).toBe(false);
  });
  it("projects the comment on its specific offer, not NFT metadata", async () => {
    records = [row(collection, "Seller's story")];
    const result = await listCommunityMarketplace();
    expect(result.items[0]).not.toHaveProperty("listingComment");
    expect(result.items[0].offers[0].listingComment).toBe("Seller's story");
    expect((await getCommunityToken(collection, "12")).items[0].offers[0].listingComment).toBe(
      "Seller's story",
    );
    expect((await getCommunityOrder(records[0].order_hash)).row.metadata).toMatchObject({
      listingComment: "Seller's story",
    });
    await reconcileCommunityOrder(records[0].order_hash);
    const update = mocks.query.mock.calls.find(([sql]) =>
      sql.startsWith("UPDATE public.marketplace_community_orders"),
    )![0];
    expect(update).not.toContain("metadata");
  });
  it("denies a five-Gnar signer before metadata or writes", async () => {
    mocks.read.mockImplementation(async ({ functionName }) =>
      functionName === "balanceOf" ? 5n : true,
    );
    await expect(publishCommunityOrder(listing())).rejects.toThrow("six Gnars");
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("publishes a six-Gnar signer with immutable fee and collection identity", async () => {
    expect(await publishCommunityOrder(listing())).toMatchObject({
      collectionAddress: collection,
      feePolicy: policy,
      source: "gnars-contract",
    });
    expect(mocks.read).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "balanceOf",
        args: [seller],
        address: DAO_ADDRESSES.token,
      }),
    );
    const insert = mocks.query.mock.calls.find(([sql]) =>
      sql.startsWith("INSERT INTO public.marketplace_community_orders"),
    )!;
    expect(insert[1][0]).toBe(protocol);
    expect(insert[1][2]).toBe(collection);
    expect(insert[1][10]).toBe("6");
    expect(new URL(String(mocks.fetch.mock.calls[0][0])).hostname).toBe(
      "base-mainnet.g.alchemy.com",
    );
  });
  it("recovers existing publication after fee or holder eligibility changes", async () => {
    records = [row()];
    vi.stubEnv("MARKETPLACE_COMMUNITY_FEE_BPS", "");
    mocks.read.mockRejectedValue(new Error("must not read"));
    expect(await publishCommunityOrder(records[0].signed_order)).toMatchObject({
      feePolicy: policy,
    });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.validate).not.toHaveBeenCalled();
  });
  it("does not republish a hidden order", async () => {
    records = [{ ...row(), hidden: true }];
    await expect(publishCommunityOrder(records[0].signed_order)).rejects.toThrow("removed");
  });
  it("rejects DAO collections and incorrect treasury fees", async () => {
    await expect(publishCommunityOrder(listing(DAO_ADDRESSES.token))).rejects.toThrow(
      "native listings",
    );
    const wrong = listing();
    wrong.parameters.consideration[1].recipient = buyer;
    await expect(publishCommunityOrder(wrong)).rejects.toThrow();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("rejects non-ERC721 contracts", async () => {
    mocks.read.mockResolvedValue(false);
    await expect(publishCommunityOrder(listing())).rejects.toThrow("ERC721");
  });
  it("rejects metadata for another collection or oversized metadata", async () => {
    mocks.fetch.mockResolvedValueOnce(
      Response.json({ tokenId: "12", contract: { address: otherCollection } }),
    );
    await expect(publishCommunityOrder(listing())).rejects.toThrow();
    mocks.fetch.mockResolvedValueOnce(new Response("x".repeat(256_001)));
    await expect(publishCommunityOrder(listing())).rejects.toThrow("too large");
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("does not expose unsafe media URLs", async () => {
    mocks.fetch.mockResolvedValueOnce(
      Response.json({
        tokenId: "12",
        contract: { address: collection },
        image: { cachedUrl: "https://127.0.0.1/private" },
      }),
    );
    expect((await getCommunityToken(collection, "12")).items[0].image).toBeNull();
  });
});

describe("community discovery and settlement", () => {
  it("batches stale collection-qualified chain checks at one block and performs one bulk update", async () => {
    records = [row(), { ...row(otherCollection), id: "2" }].map((record) => ({
      ...record,
      checked_at: new Date(Date.now() - 30_000),
    }));
    const reads = [[false, false, 0n, 0n], 0n, seller, protocol, false].map((result) => ({
      status: "success",
      result,
    }));
    mocks.multicall.mockResolvedValue([...reads, ...reads]);
    expect((await listCommunityMarketplace()).items).toHaveLength(2);
    expect(mocks.multicall).toHaveBeenCalledTimes(1);
    const call = mocks.multicall.mock.calls[0][0];
    expect(call.blockNumber).toBe(100n);
    expect(call.contracts[2]).toMatchObject({ address: collection, functionName: "ownerOf" });
    expect(call.contracts[7]).toMatchObject({ address: otherCollection, functionName: "ownerOf" });
    expect(
      mocks.query.mock.calls.filter(([sql]) => sql.includes("UPDATE") && sql.includes("UNNEST")),
    ).toHaveLength(1);
  });
  it("marks unavailable chain checks incomplete instead of advertising stale offers", async () => {
    records = [{ ...row(), checked_at: new Date(Date.now() - 30_000) }];
    mocks.multicall.mockRejectedValue(new Error("RPC down"));
    expect(await listCommunityMarketplace()).toMatchObject({ items: [], available: false });
  });
  it("keeps identical token IDs from distinct collections separate", async () => {
    records = [row(), { ...row(otherCollection), id: "2" }];
    const result = await listCommunityMarketplace();
    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.collectionAddress)).toEqual([
      collection,
      otherCollection,
    ]);
  });
  it("filters hidden public offers but preserves signed orders for cancellation", async () => {
    records = [{ ...row(), hidden: true }];
    expect((await listCommunityMarketplace()).items).toEqual([]);
    expect((await getCommunityOrder(records[0].order_hash)).listing).toEqual(
      records[0].signed_order,
    );
  });
  it("rejects hidden fulfillment before simulation", async () => {
    records = [{ ...row(), hidden: true }];
    await expect(
      prepareCommunityFulfillment({
        source: "gnars-contract",
        orderHash: records[0].order_hash,
        collectionAddress: collection,
        tokenId: "12",
        buyer,
        expectedPriceWei: "10000",
      }),
    ).rejects.toThrow("removed");
    expect(mocks.call).not.toHaveBeenCalled();
  });
  it("pins collection, token and price before fulfillment", async () => {
    records = [row()];
    for (const wrong of [
      { collectionAddress: otherCollection },
      { tokenId: "13" },
      { expectedPriceWei: "9999" },
    ]) {
      await expect(
        prepareCommunityFulfillment({
          source: "gnars-contract",
          orderHash: records[0].order_hash,
          collectionAddress: collection,
          tokenId: "12",
          buyer,
          expectedPriceWei: "10000",
          ...wrong,
        }),
      ).rejects.toThrow("changed");
    }
    expect(mocks.call).not.toHaveBeenCalled();
  });
  it("uses the stored fee after policy change and does not gate buyers by Gnars balance", async () => {
    records = [row()];
    vi.stubEnv("MARKETPLACE_COMMUNITY_FEE_BPS", "500");
    const result = await prepareCommunityFulfillment({
      source: "gnars-contract",
      orderHash: records[0].order_hash,
      collectionAddress: collection,
      tokenId: "12",
      buyer,
      expectedPriceWei: "10000",
    });
    expect(result).toMatchObject({
      feePolicy: policy,
      transaction: { to: protocol, chainId: 8453, value: "10000" },
    });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.validate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ feePolicy: policy, collectionAddress: collection }),
    );
  });
  it("rechecks moderation after RPC validation", async () => {
    records = [row()];
    mocks.call.mockImplementation(async () => {
      records[0].hidden = true;
      return { data: "0x" };
    });
    await expect(
      prepareCommunityFulfillment({
        source: "gnars-contract",
        orderHash: records[0].order_hash,
        collectionAddress: collection,
        tokenId: "12",
        buyer,
        expectedPriceWei: "10000",
      }),
    ).rejects.toThrow("removed");
  });
  it("reconciliation never restores a hidden listing", async () => {
    records = [{ ...row(), hidden: true }];
    expect(await reconcileCommunityOrder(records[0].order_hash)).toEqual({ status: "cancelled" });
    const update = mocks.query.mock.calls.find(([sql]) => sql.startsWith("UPDATE"))![0];
    expect(update).not.toContain("hidden");
    expect(update).toContain("SET status");
  });
});

describe("private seller management", () => {
  const authorization = { nonce: "9c1f6b0a-7585-4ec2-9eca-e8e4cc99ef47", walletAddress: buyer };
  it("binds path, cursor, builder and protocol, using only the verified actor as seller", async () => {
    records = [{ ...row(), hidden: true }];
    const result = await listCommunityManagedOrders(authorization, "25");
    expect(result.items[0].offers[0].moderation?.hidden).toBe(true);
    expect(mocks.authorize).toHaveBeenCalledWith({
      authorization,
      method: "GET",
      path: "/api/marketplace/community/manage",
      payload: { cursor: "25", builderCode: BUILDER_CODE, protocolAddress: protocol },
    });
    const [sql, args] = mocks.query.mock.calls.find(([sql]) => sql.startsWith("SELECT *"))!;
    expect(sql).toContain("seller = $2");
    expect(sql).toContain("expires_at > $3");
    expect(sql).toContain("status IN ('active', 'unapproved', 'invalid-owner')");
    expect(sql).not.toContain("NOT hidden");
    expect(args).toEqual([protocol, seller, expect.any(Number), "25"]);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("never exposes another seller's records even if storage returns unexpected rows", async () => {
    records = [row()];
    mocks.authorize.mockResolvedValue(buyer);
    expect(await listCommunityManagedOrders(authorization)).toMatchObject({
      items: [],
      available: false,
    });
    const args = mocks.query.mock.calls.find(([sql]) => sql.startsWith("SELECT *"))![1];
    expect(args[1]).toBe(buyer);
  });
  it("requires a valid signature before querying private storage", async () => {
    mocks.authorize.mockRejectedValue(new Error("Invalid wallet authorization"));
    await expect(listCommunityManagedOrders(authorization)).rejects.toThrow(
      "Invalid wallet authorization",
    );
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("allows cancellation access when fee setup is disabled and the seller no longer holds Gnars", async () => {
    records = [{ ...row(), hidden: true }];
    vi.stubEnv("MARKETPLACE_COMMUNITY_FEE_BPS", "");
    mocks.read.mockRejectedValue(new Error("must not check holder balance"));
    expect((await listCommunityManagedOrders(authorization)).items).toHaveLength(1);
    expect(mocks.read).not.toHaveBeenCalled();
  });
});

describe("community moderation authorization", () => {
  it("rejects a moderation signature targeting another deployment", async () => {
    vi.stubEnv("MARKETPLACE_COMMUNITY_ADMIN_ADDRESSES", seller);
    await expect(
      moderateCommunityOrder({ ...input(), protocolAddress: otherCollection }),
    ).rejects.toThrow("protocol changed");
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });
  function input() {
    return {
      orderHash: row().order_hash,
      action: "hide" as const,
      expectedRevision: 0,
      reason: "spam",
      builderCode: BUILDER_CODE,
      protocolAddress: protocol,
      authorization: { nonce: "9c1f6b0a-7585-4ec2-9eca-e8e4cc99ef47" },
    };
  }
  it("rejects non-admins before opening the database", async () => {
    await expect(moderateCommunityOrder(input())).rejects.toThrow(
      "not a community marketplace moderator",
    );
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("binds action, revision and builder code in the verified payload and audits before update", async () => {
    vi.stubEnv("MARKETPLACE_COMMUNITY_ADMIN_ADDRESSES", seller);
    records = [row()];
    expect(await moderateCommunityOrder(input())).toEqual({ hidden: true, revision: 1 });
    const { authorization, ...payload } = input();
    expect(mocks.authorize).toHaveBeenCalledWith({
      authorization,
      method: "POST",
      path: "/api/marketplace/community/moderation",
      payload,
    });
    const sqls = mocks.query.mock.calls.map(([sql]) => sql as string);
    expect(
      sqls.findIndex((sql) =>
        sql.startsWith("INSERT INTO public.marketplace_community_moderation"),
      ),
    ).toBeLessThan(sqls.findIndex((sql) => sql.startsWith("UPDATE")));
    expect(sqls.find((sql) => sql.startsWith("UPDATE"))).not.toContain("status =");
  });
  it("rejects stale revisions and rolls back without updating", async () => {
    vi.stubEnv("MARKETPLACE_COMMUNITY_ADMIN_ADDRESSES", seller);
    records = [{ ...row(), moderation_revision: 1 }];
    await expect(moderateCommunityOrder(input())).rejects.toThrow("state changed");
    expect(mocks.query).toHaveBeenCalledWith("ROLLBACK");
    expect(mocks.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false);
  });
  it("rejects replayed durable nonces", async () => {
    vi.stubEnv("MARKETPLACE_COMMUNITY_ADMIN_ADDRESSES", seller);
    records = [row()];
    const original = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (sql, ...args) =>
      sql.startsWith("INSERT INTO public.marketplace_community_moderation")
        ? { rows: [], rowCount: 0 }
        : original(sql, ...args),
    );
    await expect(moderateCommunityOrder(input())).rejects.toThrow("already used");
    expect(mocks.query).toHaveBeenCalledWith("ROLLBACK");
    expect(mocks.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false);
  });
  it("authenticates hidden queue reads and includes builder attribution", async () => {
    vi.stubEnv("MARKETPLACE_COMMUNITY_ADMIN_ADDRESSES", seller);
    records = [{ ...row(), hidden: true }];
    const authorization = input().authorization;
    expect((await listCommunityModeration(authorization)).items).toHaveLength(1);
    expect(mocks.authorize).toHaveBeenCalledWith({
      authorization,
      method: "GET",
      path: "/api/marketplace/community/moderation",
      payload: { cursor: null, builderCode: BUILDER_CODE, protocolAddress: protocol },
    });
  });
  it("rejects missing attribution without trimming signed text", () => {
    const missing = { ...input(), builderCode: undefined };
    expect(communityModerationSchema.safeParse(missing).success).toBe(false);
    expect(communityModerationSchema.parse({ ...input(), reason: " spam " }).reason).toBe(" spam ");
  });
});
