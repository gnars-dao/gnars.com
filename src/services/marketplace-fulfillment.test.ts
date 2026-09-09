import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareMarketplaceFulfillment } from "./marketplace-fulfillment";

const mocks = vi.hoisted(() => ({
  order: vi.fn(),
  offer: vi.fn(),
  validate: vi.fn(),
  encode: vi.fn(),
  simulate: vi.fn(),
  owner: vi.fn(),
  externalOrder: vi.fn(),
  externalPayload: vi.fn(),
  externalEncode: vi.fn(),
}));
vi.mock("@/lib/marketplace/opensea-fulfillment", () => ({
  encodeOpenSeaFulfillment: mocks.externalEncode,
}));
vi.mock("@/services/marketplace-opensea", () => ({
  getOpenSeaMarketplaceOrder: mocks.externalOrder,
  requestOpenSeaFulfillment: mocks.externalPayload,
}));
vi.mock("@/lib/marketplace/seaport", () => ({
  getListingFulfillment: mocks.encode,
  validateListingOnchain: mocks.validate,
}));
vi.mock("@/services/marketplace-orders", () => ({
  getMarketplaceOrder: mocks.order,
  localMarketplaceOffer: mocks.offer,
}));
vi.mock("viem", async (original) => ({
  ...(await original<typeof import("viem")>()),
  createPublicClient: () => ({ call: mocks.simulate, readContract: mocks.owner }),
}));

const hash = `0x${"a".repeat(64)}`;
const buyer = "0x2222222222222222222222222222222222222222";
const offer = {
  orderHash: hash,
  priceWei: "100",
  seller: "0x1111111111111111111111111111111111111111",
};
const input = {
  source: "gnars" as const,
  orderHash: hash,
  tokenId: "12",
  buyer,
  expectedPriceWei: "100",
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.mockResolvedValue({ parameters: { offer: [{ identifierOrCriteria: "12" }] } });
  mocks.offer.mockReturnValue(offer);
  mocks.validate.mockResolvedValue({ orderHash: hash });
  mocks.encode.mockReturnValue({
    to: "0x0000000000000068F116a894984e2DB1123eB395",
    data: "0x1234",
    value: 100n,
  });
  mocks.simulate.mockResolvedValue({});
  mocks.owner.mockResolvedValue(offer.seller);
  mocks.externalOrder.mockResolvedValue({ tokenId: "12", offer: { ...offer, source: "opensea" } });
  mocks.externalPayload.mockResolvedValue({ protocol: "seaport", fulfillment_data: {} });
  mocks.externalEncode.mockReturnValue({
    to: "0x0000000000000068F116a894984e2DB1123eB395",
    data: "0x1234",
    value: 100n,
  });
});

describe("just-in-time OpenSea fulfillment", () => {
  const externalInput = { ...input, source: "opensea" as const };
  it("fetches fresh provider data, validates calldata and simulates for the selected buyer", async () => {
    expect(await prepareMarketplaceFulfillment(externalInput)).toMatchObject({
      transaction: { value: "100", chainId: 8453 },
    });
    expect(mocks.externalOrder).toHaveBeenCalledWith(hash);
    expect(mocks.externalPayload).toHaveBeenCalledWith(hash, "12", buyer);
    expect(mocks.externalEncode).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tokenId: "12", buyer }),
    );
    expect(mocks.simulate).toHaveBeenCalledWith(
      expect.objectContaining({ account: buyer, value: 100n, data: "0x1234" }),
    );
  });
  it("rejects a changed quote or transferred NFT before requesting provider execution data", async () => {
    await expect(
      prepareMarketplaceFulfillment({ ...externalInput, expectedPriceWei: "1" }),
    ).rejects.toMatchObject({ status: 409 });
    mocks.owner.mockResolvedValueOnce(buyer);
    await expect(prepareMarketplaceFulfillment(externalInput)).rejects.toMatchObject({
      status: 409,
    });
    expect(mocks.externalPayload).not.toHaveBeenCalled();
  });
  it("never simulates or returns an opaque transaction rejected by the decoder", async () => {
    mocks.externalEncode.mockImplementationOnce(() => {
      throw new Error("Unexpected recipient");
    });
    await expect(prepareMarketplaceFulfillment(externalInput)).rejects.toMatchObject({
      code: "INVALID_FULFILLMENT",
      retryable: false,
    });
    expect(mocks.simulate).not.toHaveBeenCalled();
  });
});
describe("just-in-time local fulfillment", () => {
  it("carries the custom source through storage, validation and calldata construction", async () => {
    await prepareMarketplaceFulfillment({ ...input, source: "gnars-contract" });
    expect(mocks.order).toHaveBeenCalledWith(hash, "gnars-contract");
    expect(mocks.offer).toHaveBeenCalledWith(expect.anything(), "gnars-contract");
    expect(mocks.validate).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      requireApproval: true,
      source: "gnars-contract",
    });
    expect(mocks.encode).toHaveBeenCalledWith(expect.anything(), { source: "gnars-contract" });
    expect(mocks.externalPayload).not.toHaveBeenCalled();
  });
  it("revalidates on-chain state and simulates exact buyer calldata/value", async () => {
    expect(await prepareMarketplaceFulfillment(input)).toMatchObject({
      transaction: { chainId: 8453, value: "100" },
    });
    expect(mocks.validate).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      requireApproval: true,
      source: "gnars",
    });
    expect(mocks.simulate).toHaveBeenCalledWith(
      expect.objectContaining({ account: buyer, data: "0x1234", value: 100n }),
    );
  });
  it("rejects another NFT or changed price before constructing a wallet transaction", async () => {
    await expect(prepareMarketplaceFulfillment({ ...input, tokenId: "13" })).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      prepareMarketplaceFulfillment({ ...input, expectedPriceWei: "1" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.encode).not.toHaveBeenCalled();
  });
  it("does not return execution data for stale/cancelled orders or failed simulation", async () => {
    mocks.validate.mockRejectedValueOnce(new Error("Listing is cancelled"));
    await expect(prepareMarketplaceFulfillment(input)).rejects.toMatchObject({
      code: "ORDER_CHANGED",
      retryable: false,
    });
    expect(mocks.simulate).not.toHaveBeenCalled();
    mocks.simulate.mockRejectedValueOnce(new Error("Execution reverted"));
    await expect(prepareMarketplaceFulfillment(input)).rejects.toThrow("reverted");
  });
});

describe("actionable fulfillment failures", () => {
  it.each(["gnars", "opensea", "gnars-contract"] as const)(
    "returns a typed price change and already-owned error for %s",
    async (source) => {
      await expect(
        prepareMarketplaceFulfillment({ ...input, source, expectedPriceWei: "999" }),
      ).rejects.toMatchObject({ code: "ORDER_CHANGED", retryable: false, status: 409 });
      await expect(
        prepareMarketplaceFulfillment({ ...input, source, buyer: offer.seller }),
      ).rejects.toMatchObject({ code: "ORDER_ALREADY_OWNED", retryable: false, status: 409 });
      expect(mocks.simulate).not.toHaveBeenCalled();
    },
  );
  it.each([
    [
      "InsufficientFundsError",
      "insufficient funds for gas * price + value",
      "INSUFFICIENT_BALANCE",
      false,
    ],
    ["CallExecutionError", "execution reverted", "SIMULATION_FAILED", false],
    ["TimeoutError", "RPC timed out", "MARKETPLACE_RPC_UNAVAILABLE", true],
  ])(
    "classifies %s without another RPC or exposing the raw cause",
    async (name, message, code, retryable) => {
      mocks.simulate.mockRejectedValueOnce(
        new Error("RPC wrapper with secret URL", {
          cause: Object.assign(new Error(message), { name }),
        }),
      );
      let caught: unknown;
      try {
        await prepareMarketplaceFulfillment({ ...input, source: "opensea" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code, retryable });
      expect(String(caught)).not.toContain("secret URL");
      expect(mocks.simulate).toHaveBeenCalledOnce();
    },
  );
});
