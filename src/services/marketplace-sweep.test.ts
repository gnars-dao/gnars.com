import { encodeFunctionResult, zeroAddress, zeroHash } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAO_ADDRESSES } from "@/lib/config";
import { getListingOrderHash, type SignedListing } from "@/lib/marketplace/seaport";
import { sweepAbi } from "@/lib/marketplace/sweep";
import {
  prepareMarketplaceSweep,
  quoteMarketplaceSweep,
  sweepFulfillmentSchema,
  sweepQuoteSchema,
} from "./marketplace-sweep";

const mocks = vi.hoisted(() => ({
  candidates: vi.fn(),
  get: vi.fn(),
  validate: vi.fn(),
  metadata: vi.fn(),
  call: vi.fn(),
}));
vi.mock("./marketplace-orders", () => ({
  getMarketplaceSweepCandidates: mocks.candidates,
  getMarketplaceOrder: mocks.get,
  localMarketplaceOffer: (listing: SignedListing) => ({
    source: "gnars-contract",
    orderHash: getListingOrderHash(listing.parameters),
    priceWei: listing.parameters.consideration[0].startAmount,
  }),
}));
vi.mock("./marketplace-catalogue", () => ({ getMarketplaceMetadata: mocks.metadata }));
vi.mock("@/lib/marketplace/seaport", async (original) => ({
  ...(await original<typeof import("@/lib/marketplace/seaport")>()),
  validateListingOnchain: mocks.validate,
}));
vi.mock("./marketplace-common", async (original) => ({
  ...(await original<typeof import("./marketplace-common")>()),
  marketplaceClient: { call: mocks.call },
}));
const protocol = "0xC35813d40961151c11C97cB9d67D0D25CD4Cc86e";
const seller = "0x1111111111111111111111111111111111111111";
const buyer = "0x2222222222222222222222222222222222222222";
function listing(tokenId = "42", amount = "1000"): SignedListing {
  const now = Math.floor(Date.now() / 1000);
  return {
    parameters: {
      offerer: seller,
      zone: zeroAddress,
      offer: [
        {
          itemType: 2,
          token: DAO_ADDRESSES.token,
          identifierOrCriteria: tokenId,
          startAmount: "1",
          endAmount: "1",
        },
      ],
      consideration: [
        {
          itemType: 0,
          token: zeroAddress,
          identifierOrCriteria: "0",
          startAmount: amount,
          endAmount: amount,
          recipient: seller,
        },
      ],
      orderType: 0,
      startTime: String(now - 10),
      endTime: String(now + 86400),
      zoneHash: zeroHash,
      salt: tokenId,
      conduitKey: zeroHash,
      counter: "0",
    },
    signature: "0xabcd",
  };
}
function selection(order: SignedListing) {
  return {
    orderHash: getListingOrderHash(order.parameters),
    tokenId: order.parameters.offer[0].identifierOrCriteria,
    priceWei: order.parameters.consideration[0].startAmount,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_GNARS_MARKETPLACE_ADDRESS", protocol);
  mocks.validate.mockResolvedValue({});
  mocks.metadata.mockResolvedValue([]);
  mocks.candidates.mockResolvedValue({
    candidates: [listing(), listing("43", "2000")],
    truncated: false,
  });
  mocks.get.mockResolvedValue(listing());
  mocks.call.mockResolvedValue({
    data: encodeFunctionResult({
      abi: sweepAbi,
      functionName: "fulfillAvailableOrders",
      result: [[true], []],
    }),
  });
});
afterEach(() => vi.unstubAllEnvs());
describe("sweep service", () => {
  it("quotes floor order from complete sorted storage and batches metadata", async () => {
    const quote = await quoteMarketplaceSweep({ buyer, quantity: 2 });
    expect(quote.totalWei).toBe("3000");
    expect(quote.protocolAddress).toBe(protocol);
    expect(quote.items.map((item) => item.tokenId)).toEqual(["42", "43"]);
    expect(mocks.metadata).toHaveBeenCalledExactlyOnceWith(["42", "43"]);
    expect(mocks.candidates).toHaveBeenCalledWith(buyer, undefined);
  });
  it("skips known inactive lower offers and deduplicates NFTs before choosing cheapest valid offer", async () => {
    mocks.candidates.mockResolvedValue({
      candidates: [listing(), listing("42", "1200"), listing("42", "1300"), listing("43", "2000")],
      truncated: false,
    });
    mocks.validate.mockRejectedValueOnce(new Error("Listing is cancelled"));
    const quote = await quoteMarketplaceSweep({ buyer, quantity: 2 });
    expect(quote.totalWei).toBe("3200");
    expect(mocks.validate).toHaveBeenCalledTimes(3);
  });
  it("does not skip cheaper listings when RPC is uncertain", async () => {
    mocks.validate.mockRejectedValueOnce(new Error("RPC unavailable"));
    await expect(quoteMarketplaceSweep({ buyer, quantity: 1 })).rejects.toThrow("RPC unavailable");
  });
  it("fails closed when bounded candidates cannot certify requested floor", async () => {
    mocks.candidates.mockResolvedValue({ candidates: [listing()], truncated: true });
    await expect(quoteMarketplaceSweep({ buyer, quantity: 2 })).rejects.toThrow("request budget");
  });
  it("returns available smaller count only when full candidate set is exhausted", async () => {
    mocks.candidates.mockResolvedValue({ candidates: [listing()], truncated: false });
    expect((await quoteMarketplaceSweep({ buyer, quantity: 2 })).listings).toHaveLength(1);
  });
  it("filters self ownership without prompting", async () => {
    const self = listing();
    self.parameters.offerer = buyer;
    mocks.candidates.mockResolvedValue({ candidates: [self], truncated: false });
    await expect(quoteMarketplaceSweep({ buyer, quantity: 1 })).rejects.toMatchObject({
      code: "SWEEP_EMPTY",
    });
    expect(mocks.validate).not.toHaveBeenCalled();
  });
  it("rejects selection price/token/hash changes and own orders", async () => {
    for (const replacement of [
      { priceWei: "999" },
      { tokenId: "43" },
      { orderHash: `0x${"a".repeat(64)}` as `0x${string}` },
    ]) {
      await expect(
        prepareMarketplaceSweep({
          buyer,
          selections: [{ ...selection(listing()), ...replacement }],
          maxTotalWei: "1000",
        }),
      ).rejects.toMatchObject({ code: "ORDER_CHANGED" });
    }
    await expect(
      prepareMarketplaceSweep({
        buyer: seller,
        selections: [selection(listing())],
        maxTotalWei: "1000",
      }),
    ).rejects.toMatchObject({ code: "ORDER_CHANGED" });
    expect(mocks.call).not.toHaveBeenCalled();
  });
  it("revalidates exact selections, respects cap, simulates one exact call", async () => {
    const input = { buyer, selections: [selection(listing())], maxTotalWei: "1000" };
    const result = await prepareMarketplaceSweep(input);
    expect(result.transaction).toMatchObject({ chainId: 8453, to: protocol, value: "1000" });
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith(
      input.selections[0].orderHash,
      "gnars-contract",
    );
    expect(mocks.call).toHaveBeenCalledWith({
      account: buyer,
      to: protocol,
      value: 1000n,
      data: result.transaction.data,
    });
    await expect(prepareMarketplaceSweep({ ...input, maxTotalWei: "999" })).rejects.toMatchObject({
      code: "ORDER_CHANGED",
    });
  });
  it("rejects newly inactive or partially unavailable simulation without substitution", async () => {
    const input = { buyer, selections: [selection(listing())], maxTotalWei: "1000" };
    mocks.validate.mockRejectedValueOnce(new Error("Listing is filled"));
    await expect(prepareMarketplaceSweep(input)).rejects.toMatchObject({ code: "ORDER_CHANGED" });
    mocks.call.mockResolvedValueOnce({
      data: encodeFunctionResult({
        abi: sweepAbi,
        functionName: "fulfillAvailableOrders",
        result: [[false], []],
      }),
    });
    await expect(prepareMarketplaceSweep(input)).rejects.toMatchObject({ code: "ORDER_CHANGED" });
    expect(mocks.candidates).not.toHaveBeenCalled();
  });
  it("validates size, duplicate selections, canonical quantities and unsupported source", () => {
    expect(sweepQuoteSchema.safeParse({ buyer, quantity: 11 }).success).toBe(false);
    expect(sweepQuoteSchema.safeParse({ buyer, quantity: 1, source: "opensea" }).success).toBe(
      false,
    );
    expect(sweepQuoteSchema.safeParse({ buyer, quantity: 1, maxPriceWei: "01" }).success).toBe(
      false,
    );
    expect(
      sweepFulfillmentSchema.safeParse({
        buyer,
        selections: [selection(listing()), selection(listing())],
        maxTotalWei: "2000",
      }).success,
    ).toBe(false);
    expect(
      sweepFulfillmentSchema.safeParse({
        buyer,
        selections: [{ ...selection(listing()), tokenId: "042" }],
        maxTotalWei: "2000",
      }).success,
    ).toBe(false);
  });
});
