import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUILDER_CODE } from "@/lib/config";
import { GET as eligibility } from "./eligibility/route";
import { POST as fulfillment } from "./fulfillment/route";
import { POST as moderate, GET as queue } from "./moderation/route";
import { GET as order } from "./orders/[hash]/route";
import { POST as publish } from "./orders/route";
import { POST as reconcile } from "./reconcile/route";
import { GET as catalogue } from "./route";

const mocks = vi.hoisted(() => ({
  rate: vi.fn(),
  budget: vi.fn(),
  invalidate: vi.fn(),
  eligibility: vi.fn(),
  fulfillment: vi.fn(),
  queue: vi.fn(),
  moderate: vi.fn(),
  order: vi.fn(),
  publish: vi.fn(),
  reconcile: vi.fn(),
  catalogue: vi.fn(),
}));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: unknown) => fn,
  revalidateTag: mocks.invalidate,
}));
vi.mock("@/lib/server/request-security", async (original) => ({
  ...(await original<typeof import("@/lib/server/request-security")>()),
  enforceRateLimit: mocks.rate,
}));
vi.mock("@/services/marketplace-orders", () => ({ enforceMarketplaceBudget: mocks.budget }));
vi.mock("@/services/marketplace-community", async (original) => ({
  ...(await original<typeof import("@/services/marketplace-community")>()),
  getCommunityEligibility: mocks.eligibility,
  prepareCommunityFulfillment: mocks.fulfillment,
  listCommunityModeration: mocks.queue,
  moderateCommunityOrder: mocks.moderate,
  getCommunityOrder: mocks.order,
  publishCommunityOrder: mocks.publish,
  reconcileCommunityOrder: mocks.reconcile,
  listCommunityMarketplace: mocks.catalogue,
}));
const hash = `0x${"a".repeat(64)}`;
const address = "0x1111111111111111111111111111111111111111";
function post(path: string, body: unknown) {
  return new Request(`https://gnars.com/api/marketplace/community/${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rate.mockResolvedValue(undefined);
  mocks.budget.mockResolvedValue(undefined);
  mocks.catalogue.mockResolvedValue({ items: [], nextCursor: null, available: true });
});
describe("community route boundaries", () => {
  it("validates collection feed filters and never accepts caller-controlled protocols", async () => {
    expect(
      (await catalogue(new Request(`https://gnars.com/api/marketplace/community?owner=${address}`)))
        .status,
    ).toBe(200);
    expect(mocks.catalogue).toHaveBeenCalledWith(undefined, address);
    expect(
      (
        await catalogue(
          new Request(`https://gnars.com/api/marketplace/community?protocol=${address}`),
        )
      ).status,
    ).toBe(400);
    expect(mocks.catalogue).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid eligibility owners before RPC work", async () => {
    expect(
      (
        await eligibility(
          new Request("https://gnars.com/api/marketplace/community/eligibility?owner=invalid"),
        )
      ).status,
    ).toBe(400);
    expect(mocks.eligibility).not.toHaveBeenCalled();
  });
  it("publishes only a listing and accounts for durable creation budget", async () => {
    mocks.publish.mockResolvedValue({ id: "community:1" });
    const request = post("orders", { listing: { signature: "0x12" } });
    const response = await publish(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ offer: { id: "community:1" } });
    expect(mocks.budget).toHaveBeenCalledWith(request, "create");
    expect(mocks.invalidate).toHaveBeenCalledWith("marketplace-community", { expire: 0 });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it.each([{}, { listing: {}, eligibility: true }, { listing: {}, feePolicy: {} }])(
    "rejects missing listings and client-owned policy fields",
    async (body) => {
      expect((await publish(post("orders", body))).status).toBe(400);
      expect(mocks.publish).not.toHaveBeenCalled();
      expect(mocks.budget).not.toHaveBeenCalled();
    },
  );
  it("limits signed listing payloads", async () => {
    expect((await publish(post("orders", { listing: "x".repeat(24001) }))).status).toBe(413);
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("returns only signed order and fee snapshot for recovery", async () => {
    mocks.order.mockResolvedValue({
      listing: { signature: "0x12" },
      feePolicy: { basisPoints: 100 },
      row: { eligibility_balance: "6" },
      options: {},
    });
    const response = await order(
      new Request(`https://gnars.com/api/marketplace/community/orders/${hash}`),
      { params: Promise.resolve({ hash }) },
    );
    expect(await response.json()).toEqual({
      listing: { signature: "0x12" },
      feePolicy: { basisPoints: 100 },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("requires collection identity and own-contract source for fulfillment", async () => {
    const input = {
      source: "gnars-contract",
      orderHash: hash,
      tokenId: "12",
      buyer: address,
      expectedPriceWei: "10000",
    };
    expect((await fulfillment(post("fulfillment", input))).status).toBe(400);
    expect(
      (
        await fulfillment(
          post("fulfillment", { ...input, collectionAddress: address, source: "gnars" }),
        )
      ).status,
    ).toBe(400);
    expect(mocks.fulfillment).not.toHaveBeenCalled();
  });
  it("does not accept client-provided settlement status", async () => {
    expect((await reconcile(post("reconcile", { orderHash: hash, status: "filled" }))).status).toBe(
      400,
    );
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });
  it.each([null, "not-json", "x".repeat(20001)])(
    "requires a bounded signed header for the moderation queue",
    async (authorization) => {
      const request = new Request("https://gnars.com/api/marketplace/community/moderation", {
        headers: authorization === null ? {} : { "x-wallet-authorization": authorization },
      });
      expect((await queue(request)).status).toBe(401);
      expect(mocks.queue).not.toHaveBeenCalled();
    },
  );
  it("requires signed builder and protocol attribution for moderation", async () => {
    const payload = {
      orderHash: hash,
      action: "hide",
      expectedRevision: 0,
      reason: "spam",
      authorization: {},
    };
    expect((await moderate(post("moderation", payload))).status).toBe(400);
    mocks.moderate.mockResolvedValue({ hidden: true, revision: 1 });
    const complete = { ...payload, builderCode: BUILDER_CODE, protocolAddress: address };
    expect((await moderate(post("moderation", complete))).status).toBe(200);
    expect(mocks.moderate).toHaveBeenCalledWith(complete);
  });
});
