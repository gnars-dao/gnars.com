import { zeroAddress, zeroHash, type Address } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAO_ADDRESSES } from "@/lib/config";
import {
  getListingOrderHash,
  SEAPORT_ADDRESS,
  type SignedListing,
} from "@/lib/marketplace/seaport";
import type { MarketplaceOffer } from "@/types/marketplace";
import { mixedSweepQuoteSchema, quoteMixedMarketplaceSweep } from "./marketplace-mixed-sweep";

const mocks = vi.hoisted(() => ({
  candidates: vi.fn(),
  get: vi.fn(),
  validate: vi.fn(),
  metadata: vi.fn(),
  read: vi.fn(),
  openSea: vi.fn(),
  openSeaOrder: vi.fn(),
}));
vi.mock("./marketplace-orders", () => ({
  getMarketplaceSweepCandidates: mocks.candidates,
  getMarketplaceOrder: mocks.get,
  localMarketplaceOffer: (listing: SignedListing) => nativeOffer(listing),
}));
vi.mock("./marketplace-opensea", () => ({
  listOpenSeaMarketplace: mocks.openSea,
  getOpenSeaMarketplaceOrder: mocks.openSeaOrder,
}));
vi.mock("./marketplace-catalogue", () => ({ getMarketplaceMetadata: mocks.metadata }));
vi.mock("@/lib/marketplace/seaport", async (original) => ({
  ...(await original<typeof import("@/lib/marketplace/seaport")>()),
  validateListingOnchain: mocks.validate,
}));
vi.mock("./marketplace-common", async (original) => ({
  ...(await original<typeof import("./marketplace-common")>()),
  marketplaceClient: { readContract: mocks.read },
}));
const protocol = "0xC35813d40961151c11C97cB9d67D0D25CD4Cc86e";
const seller = "0x1111111111111111111111111111111111111111";
const buyer = "0x2222222222222222222222222222222222222222";
const expiry = () => Math.floor(Date.now() / 1000) + 86400;
function listing(tokenId = "42", amount = "1000"): SignedListing {
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
      startTime: "1",
      endTime: String(expiry()),
      zoneHash: zeroHash,
      salt: tokenId,
      conduitKey: zeroHash,
      counter: "0",
    },
    signature: "0xabcd",
  };
}
function nativeOffer(order: SignedListing): MarketplaceOffer & { source: "gnars-contract" } {
  const hash = getListingOrderHash(order.parameters);
  return {
    id: `gnars-contract:${hash}`,
    source: "gnars-contract",
    protocolAddress: protocol,
    orderHash: hash,
    seller: order.parameters.offerer,
    priceWei: order.parameters.consideration[0].startAmount,
    currency: "ETH",
    expiresAt: Number(order.parameters.endTime),
  };
}
function sea(
  tokenId = "43",
  priceWei = "900",
  overrides: Partial<Omit<MarketplaceOffer, "source">> = {},
) {
  const orderHash = `0x${BigInt(tokenId).toString(16).padStart(64, "0")}` as `0x${string}`;
  return {
    tokenId,
    offer: {
      id: `opensea:${orderHash}`,
      source: "opensea" as const,
      protocolAddress: SEAPORT_ADDRESS,
      orderHash,
      seller: seller as Address,
      priceWei,
      currency: "ETH" as const,
      expiresAt: expiry(),
      ...overrides,
    },
  };
}
function page(offers = [sea()], nextCursor: string | null = null) {
  return { offers, nextCursor, partial: false };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXT_PUBLIC_GNARS_MARKETPLACE_ADDRESS", protocol);
  mocks.candidates.mockResolvedValue({ candidates: [listing()], truncated: false });
  mocks.validate.mockResolvedValue({});
  mocks.metadata.mockResolvedValue([]);
  mocks.openSea.mockResolvedValue(page());
  mocks.get.mockResolvedValue(listing());
  mocks.openSeaOrder.mockResolvedValue(sea());
  mocks.read.mockImplementation(async ({ functionName }: { functionName: string }) =>
    functionName === "ownerOf" ? seller : [false, false, 0n, 0n],
  );
});
afterEach(() => vi.unstubAllEnvs());

describe("combined marketplace floor", () => {
  it("merges both venues by exact wei and batches metadata once", async () => {
    mocks.metadata.mockResolvedValue([{ tokenId: "43", name: "Gnar #43", image: "/gnars.webp" }]);
    const plan = await quoteMixedMarketplaceSweep({ buyer, quantity: 2 });
    expect(plan.items.map((i) => [i.tokenId, i.offers[0].source])).toEqual([
      ["43", "opensea"],
      ["42", "gnars-contract"],
    ]);
    expect(plan.totalWei).toBe("1900");
    expect(plan.items[0].image).toBe("/gnars.webp");
    expect(mocks.metadata).toHaveBeenCalledExactlyOnceWith(["43", "42"]);
  });
  it("prefers native on a price tie and never buys the same NFT twice", async () => {
    mocks.openSea.mockResolvedValue(
      page([sea("42", "1000"), sea("44", "1000"), sea("43", "1100")]),
    );
    const plan = await quoteMixedMarketplaceSweep({ buyer, quantity: 3 });
    expect(plan.items.map((i) => [i.tokenId, i.offers[0].source])).toEqual([
      ["42", "gnars-contract"],
      ["44", "opensea"],
      ["43", "opensea"],
    ]);
    expect(plan.totalWei).toBe("3100");
  });
  it("chooses OpenSea when its listing for the same NFT is cheaper", async () => {
    mocks.openSea.mockResolvedValue(page([sea("42", "999")]));
    const plan = await quoteMixedMarketplaceSweep({ buyer, quantity: 2 });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].offers[0].source).toBe("opensea");
  });
  it("applies the maximum to both venues and excludes own listings", async () => {
    mocks.openSea.mockResolvedValue(
      page([sea("40", "100", { seller: buyer }), sea("43", "900"), sea("44", "1001")]),
    );
    const plan = await quoteMixedMarketplaceSweep({ buyer, quantity: 3, maxPriceWei: "1000" });
    expect(plan.items.map((i) => i.tokenId)).toEqual(["43", "42"]);
    expect(mocks.candidates).toHaveBeenCalledWith(buyer, "1000");
  });
  it("skips cached expired OpenSea offers before reading ownership", async () => {
    mocks.openSea.mockResolvedValue(
      page([sea("43", "900", { expiresAt: Math.floor(Date.now() / 1000) - 1 })]),
    );
    const plan = await quoteMixedMarketplaceSweep({ buyer, quantity: 1 });
    expect(plan.items[0].tokenId).toBe("42");
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("skips cancelled, filled and transferred OpenSea orders", async () => {
    mocks.openSea.mockResolvedValue(
      page([sea("40", "100"), sea("41", "200"), sea("43", "300"), sea("44", "900")]),
    );
    mocks.read.mockImplementation(
      async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
        if (functionName === "ownerOf") return args[0] === 43n ? buyer : seller;
        if (args[0] === sea("40").offer.orderHash) return [false, true, 0n, 0n];
        if (args[0] === sea("41").offer.orderHash) return [true, false, 1n, 1n];
        return [false, false, 0n, 0n];
      },
    );
    expect(
      (await quoteMixedMarketplaceSweep({ buyer, quantity: 2 })).items.map((i) => i.tokenId),
    ).toEqual(["44", "42"]);
  });
  it("skips known inactive native orders but fails closed on uncertain reads", async () => {
    mocks.validate.mockRejectedValueOnce(new Error("Listing is cancelled"));
    expect(
      (await quoteMixedMarketplaceSweep({ buyer, quantity: 2 })).items.map((i) => i.tokenId),
    ).toEqual(["43"]);
    mocks.validate.mockRejectedValueOnce(new Error("RPC unavailable"));
    await expect(quoteMixedMarketplaceSweep({ buyer, quantity: 2 })).rejects.toThrow(
      "RPC unavailable",
    );
  });
  it("does not silently substitute when OpenSea or its ownership RPC fails", async () => {
    mocks.openSea.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(quoteMixedMarketplaceSweep({ buyer, quantity: 1 })).rejects.toThrow(
      "provider unavailable",
    );
    mocks.read.mockRejectedValueOnce(new Error("RPC unavailable"));
    await expect(quoteMixedMarketplaceSweep({ buyer, quantity: 1 })).rejects.toThrow(
      "RPC unavailable",
    );
    mocks.openSea.mockResolvedValueOnce({ ...page(), partial: true });
    await expect(quoteMixedMarketplaceSweep({ buyer, quantity: 1 })).rejects.toThrow(
      "request budget",
    );
  });
  it("continues pagination after cheaper candidates prove inactive", async () => {
    mocks.openSea
      .mockResolvedValueOnce(page([sea("43", "900")], "page-2"))
      .mockResolvedValueOnce(page([sea("44", "1100")]));
    mocks.read.mockImplementation(
      async ({ functionName, args }: { functionName: string; args: unknown[] }) =>
        functionName === "ownerOf"
          ? seller
          : [false, args[0] === sea("43").offer.orderHash, 0n, 0n],
    );
    const plan = await quoteMixedMarketplaceSweep({ buyer, quantity: 2 });
    expect(plan.items.map((i) => i.tokenId)).toEqual(["42", "44"]);
    expect(mocks.openSea).toHaveBeenNthCalledWith(2, "page-2");
    expect(mocks.validate).toHaveBeenCalledTimes(1);
  });
  it("uses an ascending frontier to avoid unnecessary provider pages", async () => {
    mocks.openSea.mockResolvedValue(page([sea("43", "1100")], "page-2"));
    expect((await quoteMixedMarketplaceSweep({ buyer, quantity: 1 })).items[0].tokenId).toBe("42");
    expect(mocks.openSea).toHaveBeenCalledTimes(1);
  });
  it("fails closed at the page budget rather than claiming an incomplete floor", async () => {
    mocks.openSea
      .mockResolvedValueOnce(page([], "page-2"))
      .mockResolvedValueOnce(page([], "page-3"))
      .mockResolvedValueOnce(page([], "page-4"));
    await expect(quoteMixedMarketplaceSweep({ buyer, quantity: 2 })).rejects.toThrow(
      "request budget",
    );
    expect(mocks.openSea).toHaveBeenCalledTimes(3);
  });
  it("rejects repeated provider cursors", async () => {
    mocks.openSea.mockResolvedValue(page([], "same"));
    await expect(quoteMixedMarketplaceSweep({ buyer, quantity: 2 })).rejects.toThrow(
      "request budget",
    );
    expect(mocks.openSea.mock.calls.length).toBeLessThanOrEqual(3);
  });
  it("limits onchain eligibility work even when many lower listings are stale", async () => {
    mocks.candidates.mockResolvedValue({
      candidates: Array.from({ length: 31 }, (_, index) =>
        listing(String(index + 1), String(index + 1)),
      ),
      truncated: false,
    });
    mocks.validate.mockRejectedValue(new Error("Listing is cancelled"));
    mocks.openSea.mockResolvedValue(page([]));
    await expect(quoteMixedMarketplaceSweep({ buyer, quantity: 1 })).rejects.toThrow(
      "request budget",
    );
    expect(mocks.validate).toHaveBeenCalledTimes(30);
  });
  it("fails closed when native truncation leaves the requested floor uncertain", async () => {
    mocks.candidates.mockResolvedValue({ candidates: [listing()], truncated: true });
    mocks.openSea.mockResolvedValue(page([]));
    await expect(quoteMixedMarketplaceSweep({ buyer, quantity: 2 })).rejects.toThrow(
      "request budget",
    );
  });
  it("revalidates exact manual selections without scanning either feed", async () => {
    const native = listing();
    const external = sea();
    const selections = [
      { ...nativeOffer(native), tokenId: "42" },
      { ...external.offer, tokenId: "43" },
    ].map(({ source, tokenId, orderHash, priceWei }) => ({ source, tokenId, orderHash, priceWei }));
    const plan = await quoteMixedMarketplaceSweep({ buyer, quantity: 2, selections });
    expect(plan.items.map((i) => i.tokenId)).toEqual(["42", "43"]);
    expect(mocks.get).toHaveBeenCalledWith(selections[0].orderHash, "gnars-contract");
    expect(mocks.openSeaOrder).toHaveBeenCalledWith(selections[1].orderHash);
    expect(mocks.candidates).not.toHaveBeenCalled();
    expect(mocks.openSea).not.toHaveBeenCalled();
  });
  it.each([{ tokenId: "44" }, { priceWei: "901" }, { orderHash: zeroHash }])(
    "rejects exact order tampering %j",
    async (replacement) => {
      const external = sea();
      const { source, orderHash, priceWei } = external.offer;
      await expect(
        quoteMixedMarketplaceSweep({
          buyer,
          quantity: 1,
          selections: [{ source, orderHash, priceWei, tokenId: external.tokenId, ...replacement }],
        }),
      ).rejects.toMatchObject({ code: "ORDER_CHANGED" });
    },
  );
  it("rejects manual listings that are owned, inactive or exceed the reviewed maximum", async () => {
    const external = sea();
    const { source, orderHash, priceWei } = external.offer;
    const input = {
      buyer,
      quantity: 1,
      selections: [{ source, orderHash, priceWei, tokenId: external.tokenId }],
    };
    await expect(
      quoteMixedMarketplaceSweep({ ...input, maxPriceWei: "899" }),
    ).rejects.toMatchObject({ code: "ORDER_CHANGED" });
    mocks.openSeaOrder.mockResolvedValueOnce(sea("43", "900", { seller: buyer }));
    await expect(quoteMixedMarketplaceSweep(input)).rejects.toMatchObject({
      code: "ORDER_CHANGED",
    });
    mocks.read.mockImplementation(async ({ functionName }: { functionName: string }) =>
      functionName === "ownerOf" ? seller : [false, true, 0n, 0n],
    );
    await expect(quoteMixedMarketplaceSweep(input)).rejects.toMatchObject({
      code: "ORDER_CHANGED",
    });
  });
  it("rejects duplicate NFTs, unsupported sources and noncanonical request values", () => {
    const selection = {
      tokenId: "43",
      source: "opensea",
      orderHash: sea().offer.orderHash,
      priceWei: "900",
    };
    for (const input of [
      { buyer, quantity: 11 },
      { buyer, quantity: 1, maxPriceWei: "01" },
      { buyer, quantity: 2, selections: [selection, selection] },
      { buyer, quantity: 1, selections: [{ ...selection, source: "gnars" }] },
      { buyer, quantity: 1, selections: [{ ...selection, tokenId: "043" }] },
    ])
      expect(mixedSweepQuoteSchema.safeParse(input).success).toBe(false);
  });
});
