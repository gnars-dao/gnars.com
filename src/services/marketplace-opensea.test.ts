import { zeroAddress } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAO_ADDRESSES } from "@/lib/config";
import { SEAPORT_ADDRESS } from "@/lib/marketplace/seaport";
import {
  getOpenSeaMarketplaceOrder,
  getOpenSeaTokenListing,
  listOpenSeaMarketplace,
  normalizeOpenSeaListing,
  parseOpenSeaJson,
  requestOpenSeaFulfillment,
} from "./marketplace-opensea";

vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
const budget = vi.hoisted(() => vi.fn());
vi.mock("./marketplace-orders", () => ({ enforceOpenSeaProviderBudget: budget }));

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
    protocol_address: SEAPORT_ADDRESS,
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
  vi.stubEnv("OPENSEA_API_KEY", "test-secret");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
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
