import { zeroAddress, zeroHash, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAO_ADDRESSES } from "@/lib/config";
import {
  getListingOrderHash,
  SEAPORT_ADDRESS,
  type SignedListing,
} from "@/lib/marketplace/seaport";
import {
  getOpenSeaCancellationOrder,
  getOpenSeaListingQuote,
  getOpenSeaMarketplaceOrder,
  getOpenSeaTokenListing,
  invalidateOpenSeaOrdersCache,
  listOpenSeaMarketplace,
  normalizeOpenSeaListing,
  parseOpenSeaJson,
  publishOpenSeaListing,
  reconcileOpenSeaOrder,
  requestOpenSeaFulfillment,
} from "./marketplace-opensea";

const invalidate = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn, revalidateTag: invalidate }));
const budget = vi.hoisted(() => vi.fn());
const onchain = vi.hoisted(() => vi.fn());
const readContract = vi.hoisted(() => vi.fn());
vi.mock("./marketplace-orders", () => ({ enforceOpenSeaProviderBudget: budget }));
vi.mock("@/lib/marketplace/seaport", async (original) => ({
  ...(await original<typeof import("@/lib/marketplace/seaport")>()),
  validateListingOnchain: onchain,
}));
vi.mock("@/services/marketplace-common", async (original) => ({
  ...(await original<typeof import("@/services/marketplace-common")>()),
  marketplaceClient: { readContract },
}));

const hash = `0x${"a".repeat(64)}`;
const seller = "0x1111111111111111111111111111111111111111";
const fetchMock = vi.fn<typeof fetch>();
let testTime = Date.now();

// Wire names/envelope follow OpenSea get_order.md GetOrderResponse and Listing schemas.
function listing() {
  return {
    type: "basic",
    chain: "base",
    status: "ACTIVE",
    remaining_quantity: 1,
    order_hash: hash,
    protocol_address: SEAPORT_ADDRESS as string,
    price: { current: { currency: "ETH", decimals: 18, value: "10000000000000000" } },
    protocol_data: {
      parameters: {
        offerer: seller,
        orderType: 2,
        startTime: String(Math.floor(Date.now() / 1000) - 60),
        endTime: String(Math.floor(Date.now() / 1000) + 3600),
        offer: [
          {
            itemType: 2,
            token: DAO_ADDRESSES.token,
            identifierOrCriteria: "12",
            startAmount: "1",
            endAmount: "1",
          },
        ],
        consideration: [
          {
            itemType: 0,
            token: zeroAddress,
            identifierOrCriteria: "0",
            startAmount: "10000000000000000",
            endAmount: "10000000000000000",
            recipient: seller,
          },
        ],
      },
    },
  };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  testTime += 7_200_000;
  vi.setSystemTime(testTime);
  budget.mockReset().mockResolvedValue(undefined);
  onchain.mockReset().mockResolvedValue({});
  readContract.mockReset();
  invalidate.mockReset();
  vi.stubEnv("OPENSEA_API_KEY", "test-secret");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

function collection() {
  return {
    collection: "gnars-dao",
    contracts: [{ address: DAO_ADDRESSES.token, chain: "base" }],
    required_zone: zeroAddress,
    fees: [{ fee: 1, recipient: "0x2222222222222222222222222222222222222222", required: true }],
  };
}

function signedListing(): SignedListing {
  const raw = listing();
  const item = raw.protocol_data.parameters.consideration[0];
  return {
    parameters: {
      ...raw.protocol_data.parameters,
      offerer: seller,
      zone: zeroAddress,
      zoneHash: zeroHash,
      conduitKey: zeroHash,
      salt: "123",
      counter: "0",
      orderType: 0,
      offer: raw.protocol_data.parameters.offer.map((nft) => ({
        ...nft,
        token: DAO_ADDRESSES.token,
      })),
      consideration: [
        {
          ...item,
          token: zeroAddress,
          recipient: seller,
          startAmount: "9900000000000000",
          endAmount: "9900000000000000",
        },
        {
          ...item,
          token: zeroAddress,
          recipient: "0x2222222222222222222222222222222222222222",
          startAmount: "100000000000000",
          endAmount: "100000000000000",
        },
      ],
    },
    signature: "0x1234",
  };
}

function publishedOrder(order = signedListing()) {
  return {
    ...listing(),
    order_hash: getListingOrderHash(order.parameters),
    protocol_data: order,
  };
}

describe("OpenSea listing publication", () => {
  it("reads required collection fees without a database and ignores optional fees", async () => {
    const raw = collection();
    raw.fees.push({ fee: 5, recipient: seller, required: false });
    fetchMock.mockResolvedValueOnce(Response.json(raw));
    expect(await getOpenSeaListingQuote("10000")).toEqual({
      priceWei: "10000",
      sellerWei: "9900",
      fees: [{ recipient: raw.fees[0].recipient, basisPoints: 100, amountWei: "100" }],
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/collections/gnars-dao");
    expect(budget).toHaveBeenCalledExactlyOnceWith("read");
  });

  it("does not convert a malformed collection or outage into zero fees", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ...collection(), contracts: [] }));
    await expect(getOpenSeaListingQuote("10000")).rejects.toMatchObject({ status: 503 });
    fetchMock.mockResolvedValueOnce(new Response("offline", { status: 503 }));
    await expect(getOpenSeaListingQuote("10000")).rejects.toMatchObject({ status: 503 });
  });

  it("rejects a price too small for a required fee as a client error", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(collection()));
    await expect(getOpenSeaListingQuote("1")).rejects.toMatchObject({ status: 400 });
  });

  it("validates malformed or wrong-collection listings before RPC or provider work", async () => {
    await expect(publishOpenSeaListing({})).rejects.toMatchObject({ status: 400 });
    const wrong = signedListing();
    wrong.parameters.offer[0].token = seller;
    await expect(publishOpenSeaListing(wrong)).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onchain).not.toHaveBeenCalled();
  });

  it("rejects invalid onchain authorization before publishing or fetching provider data", async () => {
    onchain.mockRejectedValueOnce(new Error("Invalid owner signature"));
    await expect(publishOpenSeaListing(signedListing())).rejects.toThrow("Invalid owner signature");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("publishes only after fresh fee validation and verifies the canonical accepted order", async () => {
    const signed = signedListing();
    fetchMock.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    fetchMock.mockResolvedValueOnce(Response.json(collection()));
    fetchMock.mockResolvedValueOnce(
      Response.json({ order_hash: getListingOrderHash(signed.parameters) }),
    );
    fetchMock.mockResolvedValueOnce(Response.json({ order: publishedOrder(signed) }));
    expect(await publishOpenSeaListing(signed)).toMatchObject({
      source: "opensea",
      orderHash: getListingOrderHash(signed.parameters),
      priceWei: "10000000000000000",
    });
    expect(onchain).toHaveBeenCalledWith(expect.anything(), signed, {
      source: "opensea",
      requireApproval: true,
    });
    expect(String(fetchMock.mock.calls[2][0])).toContain("/orders/base/seaport/listings");
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({
      ...signed,
      parameters: {
        ...signed.parameters,
        totalOriginalConsiderationItems: signed.parameters.consideration.length,
      },
      protocol_address: SEAPORT_ADDRESS,
    });
    expect(budget.mock.calls.map(([operation]) => operation)).toEqual([
      "read",
      "read",
      "posting",
      "read",
    ]);
  });

  it("treats the canonical GET's exact HTTP 400 Order not found as an unpublished order", async () => {
    const signed = signedListing();
    const originalHash = getListingOrderHash(signed.parameters);
    fetchMock.mockResolvedValueOnce(
      Response.json({ errors: ["Order not found"] }, { status: 400 }),
    );
    fetchMock.mockResolvedValueOnce(Response.json(collection()));
    fetchMock.mockResolvedValueOnce(Response.json({ order_hash: originalHash }));
    fetchMock.mockResolvedValueOnce(Response.json({ order: publishedOrder(signed) }));
    expect(await publishOpenSeaListing(signed)).toMatchObject({ orderHash: originalHash });
    const wire = JSON.parse(String(fetchMock.mock.calls[2][1]?.body));
    expect(wire.parameters.totalOriginalConsiderationItems).toBe(2);
    expect(signed.parameters).not.toHaveProperty("totalOriginalConsiderationItems");
    expect(getListingOrderHash(signed.parameters)).toBe(originalHash);
    expect(wire.signature).toBe(signed.signature);
  });

  it.each([
    { errors: ["Invalid protocol"] },
    { errors: ["Order not found", "Unauthorized"] },
    { errors: "Order not found" },
    { errors: [] },
    { error: "Order not found" },
    null,
  ])("does not publish after an arbitrary or malformed canonical GET 400", async (body) => {
    fetchMock.mockResolvedValueOnce(Response.json(body, { status: 400 }));
    await expect(publishOpenSeaListing(signedListing())).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
  });

  it("does not treat invalid JSON in a canonical GET 400 as a missing order", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not json", { status: 400 }));
    await expect(publishOpenSeaListing(signedListing())).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not treat a publication POST 400 Order not found as success", async () => {
    fetchMock.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    fetchMock.mockResolvedValueOnce(Response.json(collection()));
    fetchMock.mockResolvedValueOnce(
      Response.json({ errors: ["Order not found"] }, { status: 400 }),
    );
    await expect(publishOpenSeaListing(signedListing())).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][1]?.method).toBe("POST");
  });

  it("limits the HTTP 400 compatibility case to optional canonical order reads", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ errors: ["Order not found"] }, { status: 400 }),
    );
    await expect(getOpenSeaTokenListing("12")).rejects.toMatchObject({ status: 503 });
    fetchMock.mockResolvedValueOnce(
      Response.json({ errors: ["Order not found"] }, { status: 400 }),
    );
    await expect(getOpenSeaMarketplaceOrder(hash)).rejects.toMatchObject({ status: 503 });
    fetchMock.mockResolvedValueOnce(
      Response.json({ errors: ["Order not found"] }, { status: 400 }),
    );
    await expect(getOpenSeaCancellationOrder(hash)).rejects.toMatchObject({ status: 404 });
  });

  it("does not reuse an earlier quote when collection fees change", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(collection()));
    await getOpenSeaListingQuote("10000000000000000");
    const changed = collection();
    changed.fees[0].fee = 2;
    fetchMock.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    fetchMock.mockResolvedValueOnce(Response.json(changed));
    await expect(publishOpenSeaListing(signedListing())).rejects.toMatchObject({ status: 409 });
    expect(fetchMock.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
    expect(invalidate).toHaveBeenCalledExactlyOnceWith("marketplace-opensea-listing-fees", {
      expire: 0,
    });
  });

  it("retries only the same verifiable existing signed order without posting twice", async () => {
    const signed = signedListing();
    fetchMock.mockResolvedValueOnce(Response.json({ order: publishedOrder(signed) }));
    expect(await publishOpenSeaListing(signed)).toMatchObject({
      orderHash: getListingOrderHash(signed.parameters),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["hash", "price", "seller", "token", "components", "chain", "protocol"])(
    "rejects a mismatched publication %s",
    async (field) => {
      const signed = signedListing();
      const raw = publishedOrder(signedListing());
      if (field === "hash") raw.order_hash = zeroHash;
      if (field === "price") raw.price.current.value = "1";
      if (field === "seller")
        raw.protocol_data.parameters.offerer = "0x3333333333333333333333333333333333333333";
      if (field === "token") raw.protocol_data.parameters.offer[0].identifierOrCriteria = "13";
      if (field === "components") raw.protocol_data.parameters.salt = "124";
      if (field === "chain") raw.chain = "ethereum";
      if (field === "protocol") raw.protocol_address = zeroAddress;
      fetchMock.mockResolvedValueOnce(Response.json({ order: raw }));
      await expect(publishOpenSeaListing(signed)).rejects.toMatchObject({ status: 503 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("does not call a generic conflict a successful publication", async () => {
    fetchMock.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    fetchMock.mockResolvedValueOnce(Response.json(collection()));
    fetchMock.mockResolvedValueOnce(Response.json({ errors: ["duplicate"] }, { status: 409 }));
    await expect(publishOpenSeaListing(signedListing())).rejects.toMatchObject({ status: 503 });
  });

  it("retrieves verified expired orders for cancellation and rejects missing or forged orders", async () => {
    const signed = signedListing();
    signed.parameters.startTime = String(Math.floor(Date.now() / 1000) - 7200);
    signed.parameters.endTime = String(Math.floor(Date.now() / 1000) - 3600);
    const raw = { ...publishedOrder(signed), status: "EXPIRED" };
    fetchMock.mockResolvedValueOnce(Response.json({ order: raw }));
    expect(await getOpenSeaCancellationOrder(raw.order_hash)).toEqual(raw);
    fetchMock.mockResolvedValueOnce(Response.json({ order: raw }));
    await expect(getOpenSeaCancellationOrder(hash)).rejects.toMatchObject({ status: 503 });
    fetchMock.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    await expect(getOpenSeaCancellationOrder(hash)).rejects.toMatchObject({ status: 404 });
  });

  it("keeps posting cooldown separate from fulfillment and reads", async () => {
    fetchMock.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    fetchMock.mockResolvedValueOnce(Response.json(collection()));
    fetchMock.mockResolvedValueOnce(
      new Response("limited", { status: 429, headers: { "retry-after": "90" } }),
    );
    await expect(publishOpenSeaListing(signedListing())).rejects.toMatchObject({
      status: 503,
      retryAfter: 90,
    });
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    expect(await requestOpenSeaFulfillment(hash, "12", seller)).toEqual({ ok: true });
    fetchMock.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    fetchMock.mockResolvedValueOnce(Response.json(collection()));
    await expect(publishOpenSeaListing(signedListing())).rejects.toMatchObject({ status: 503 });
    expect(budget.mock.calls.filter(([operation]) => operation === "posting")).toHaveLength(1);
  });

  it.each([
    [false, 0n, 0n, "active"],
    [true, 0n, 0n, "cancelled"],
    [false, 1n, 1n, "filled"],
    [false, 1n, 2n, "active"],
  ])("reconciles only confirmed final onchain status", async (cancelled, filled, size, status) => {
    readContract.mockResolvedValueOnce([false, cancelled, filled, size]);
    expect(await reconcileOpenSeaOrder(hash as `0x${string}`)).toEqual({ status });
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "getOrderStatus", args: [hash] }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("OpenSea order cache invalidation cooldown", () => {
  it("bounds global invalidation to 5 seconds and duplicate orders to 30 seconds per instance", () => {
    expect(invalidateOpenSeaOrdersCache(hash as Hex)).toBe(true);
    for (let index = 0; index < 20; index++)
      expect(invalidateOpenSeaOrdersCache(hash as Hex)).toBe(false);
    vi.setSystemTime(testTime + 4_999);
    expect(invalidateOpenSeaOrdersCache(zeroHash)).toBe(false);
    vi.setSystemTime(testTime + 5_000);
    expect(invalidateOpenSeaOrdersCache(zeroHash)).toBe(true);
    vi.setSystemTime(testTime + 29_999);
    expect(invalidateOpenSeaOrdersCache(hash as Hex)).toBe(false);
    expect(invalidate).toHaveBeenCalledWith("marketplace-opensea-orders", { expire: 0 });
    vi.setSystemTime(testTime + 30_000);
    expect(invalidateOpenSeaOrdersCache(hash as Hex)).toBe(true);
    expect(invalidate).toHaveBeenCalledTimes(3);
  });
  it("does not record a successful invalidation when the cache backend fails", () => {
    invalidate.mockImplementationOnce(() => {
      throw new Error("Cache unavailable");
    });
    expect(() => invalidateOpenSeaOrdersCache(hash as Hex)).toThrow("Cache unavailable");
    expect(invalidateOpenSeaOrdersCache(hash as Hex)).toBe(true);
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("OpenSea marketplace adapter", () => {
  it("preserves original 256-bit integer lexemes in actual provider response bodies", async () => {
    const salt = (2n ** 255n + 1n).toString();
    fetchMock.mockResolvedValueOnce(
      new Response(
        `{"fulfillment_data":{"transaction":{"input_data":{"parameters":{"salt":${salt},"considerationAmount":10000000000000001,"offerAmount":1}}}}}`,
      ),
    );
    expect(await requestOpenSeaFulfillment(hash, "12", seller)).toMatchObject({
      fulfillment_data: {
        transaction: {
          input_data: {
            parameters: {
              salt,
              considerationAmount: "10000000000000001",
              offerAmount: 1,
            },
          },
        },
      },
    });
  });
  it("rejects unsafe numeric values if raw integer precision cannot be recovered", () => {
    expect(() => parseOpenSeaJson('{"salt":1e50}')).toThrow("precision");
    const original = JSON.parse;
    const parse = vi.spyOn(JSON, "parse").mockImplementationOnce((text, reviver) =>
      original(text, function (key, value) {
        return reviver ? reviver.call(this, key, value) : value;
      }),
    );
    try {
      expect(() => parseOpenSeaJson('{"salt":10000000000000001}')).toThrow("precision");
    } finally {
      parse.mockRestore();
    }
  });
  it("normalizes fixed native ETH Gnars listings without exposing protocol signatures", () => {
    expect(normalizeOpenSeaListing(listing())).toMatchObject({
      tokenId: "12",
      offer: {
        source: "opensea",
        priceWei: "10000000000000000",
        seller,
        currency: "ETH",
      },
    });
    expect(JSON.stringify(normalizeOpenSeaListing(listing()))).not.toContain("protocol_data");
  });
  it("skips inactive listings and unsupported chains instead of treating them as outages", () => {
    expect(normalizeOpenSeaListing({ status: "EXPIRED", chain: "base" })).toBeNull();
    expect(normalizeOpenSeaListing({ status: "ACTIVE", chain: "ethereum" })).toBeNull();
  });
  it.each([1, 3])("accepts orderType %i for a whole singleton ERC721 purchase", (orderType) => {
    const order = listing();
    order.protocol_data.parameters.orderType = orderType;
    expect(normalizeOpenSeaListing(order)).toMatchObject({ tokenId: "12" });
  });
  it("rejects different NFTs, ERC20 payment, multi-unit orders and changing prices", () => {
    const wrong = listing();
    wrong.protocol_data.parameters.offer[0].token = seller;
    expect(normalizeOpenSeaListing(wrong)).toBeNull();
    const erc20 = listing();
    erc20.protocol_data.parameters.consideration[0].itemType = 1;
    expect(normalizeOpenSeaListing(erc20)).toBeNull();
    const multiple = listing();
    multiple.protocol_data.parameters.orderType = 1;
    multiple.protocol_data.parameters.offer[0].startAmount = "2";
    multiple.protocol_data.parameters.offer[0].endAmount = "2";
    expect(normalizeOpenSeaListing(multiple)).toBeNull();
    const contractOrder = listing();
    contractOrder.protocol_data.parameters.orderType = 4;
    expect(normalizeOpenSeaListing(contractOrder)).toBeNull();
    const dutch = listing();
    dutch.protocol_data.parameters.consideration[0].endAmount = "1";
    expect(normalizeOpenSeaListing(dutch)).toBeNull();
  });
  it("does not trust a displayed price inconsistent with the signed consideration", () => {
    const wrong = listing();
    wrong.price.current.value = "1";
    expect(() => normalizeOpenSeaListing(wrong)).toThrow("inconsistent");
  });
  it("unwraps official get-order envelope and rejects a bare listing response", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ order: listing() }));
    expect((await getOpenSeaMarketplaceOrder(hash)).tokenId).toBe("12");
    fetchMock.mockResolvedValueOnce(Response.json(listing()));
    await expect(getOpenSeaMarketplaceOrder(hash)).rejects.toThrow("invalid order response");
  });
  it("uses no-store upstream and bounded collection cursors", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ listings: [listing()], next: "next-page" }));
    expect(await listOpenSeaMarketplace("previous-page")).toMatchObject({
      nextCursor: "next-page",
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("limit=24&next=previous-page");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      cache: "no-store",
      headers: { "x-api-key": "test-secret" },
    });
  });
  it("fails explicitly without a configured key or on malformed/provider failure", async () => {
    vi.stubEnv("OPENSEA_API_KEY", "");
    await expect(listOpenSeaMarketplace()).rejects.toThrow("not configured");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv("OPENSEA_API_KEY", "test-secret");
    fetchMock.mockResolvedValueOnce(Response.json({ error: "quota exceeded" }));
    await expect(listOpenSeaMarketplace()).rejects.toThrow("invalid page");
    fetchMock.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    await expect(listOpenSeaMarketplace()).rejects.toThrow("unavailable");
  });
  it("distinguishes a token with no listing from a provider outage", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    expect(await getOpenSeaTokenListing("12")).toBeNull();
    fetchMock.mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
    await expect(getOpenSeaTokenListing("12")).rejects.toThrow("unavailable");
  });
  it("reports provider operation and HTTP status without disclosing response bodies", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ errors: ["secret echoed: test-secret signature 0x1234"] }, { status: 403 }),
    );
    await expect(getOpenSeaMarketplaceOrder(hash)).rejects.toMatchObject({
      status: 503,
      message: "OpenSea read unavailable: provider HTTP 403.",
    });
    fetchMock.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    fetchMock.mockResolvedValueOnce(Response.json(collection()));
    fetchMock.mockResolvedValueOnce(
      Response.json({ errors: ["secret echoed: test-secret signature 0x1234"] }, { status: 400 }),
    );
    await expect(publishOpenSeaListing(signedListing())).rejects.toMatchObject({
      status: 503,
      message: "OpenSea posting unavailable: provider HTTP 400.",
    });
  });
  it("distinguishes network failures from invalid provider JSON without leaking details", async () => {
    fetchMock.mockRejectedValueOnce(new Error("https://private.example/test-secret"));
    await expect(getOpenSeaMarketplaceOrder(hash)).rejects.toMatchObject({
      message: "OpenSea read unavailable: network request failed.",
    });
    fetchMock.mockResolvedValueOnce(new Response("private non-JSON response test-secret"));
    await expect(getOpenSeaMarketplaceOrder(hash)).rejects.toMatchObject({
      message: "OpenSea read unavailable: invalid JSON response.",
    });
  });
  it("coalesces concurrent reads and charges only one outbound request", async () => {
    fetchMock.mockImplementation(async () => Response.json({ order: listing() }));
    const orders = await Promise.all(
      Array.from({ length: 20 }, () => getOpenSeaMarketplaceOrder(hash)),
    );
    expect(orders).toHaveLength(20);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(budget).toHaveBeenCalledExactlyOnceWith("read");
    await getOpenSeaMarketplaceOrder(hash);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("releases failed in-flight reads so a later request can recover", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await expect(getOpenSeaMarketplaceOrder(hash)).rejects.toThrow("unavailable");
    fetchMock.mockResolvedValueOnce(Response.json({ order: listing() }));
    expect(await getOpenSeaMarketplaceOrder(hash)).toMatchObject({ tokenId: "12" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("honors provider cooldown across different NFT reads without retrying upstream", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("limited", { status: 429, headers: { "Retry-After": "90" } }),
    );
    await expect(getOpenSeaTokenListing("12")).rejects.toMatchObject({
      status: 503,
      retryAfter: 90,
    });
    await expect(getOpenSeaTokenListing("13")).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(testTime + 91_000);
    fetchMock.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    expect(await getOpenSeaTokenListing("13")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("bounds distinct read misses before spending provider quota, even without storage", async () => {
    fetchMock.mockImplementation(async () => new Response("not found", { status: 404 }));
    for (let index = 0; index < 30; index++) await getOpenSeaTokenListing(String(index));
    await expect(getOpenSeaTokenListing("30")).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(30);
    expect(budget).toHaveBeenCalledTimes(30);
  });
  it("does not forward requests after a distributed budget failure", async () => {
    budget.mockRejectedValueOnce(new Error("budget exhausted"));
    await expect(getOpenSeaMarketplaceOrder(hash)).rejects.toThrow("budget exhausted");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
