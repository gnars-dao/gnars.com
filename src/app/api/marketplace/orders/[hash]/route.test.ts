import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequestSecurityError } from "@/lib/server/request-security";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({ getOrder: vi.fn() }));
vi.mock("@/services/marketplace-orders", () => ({ getMarketplaceOrder: mocks.getOrder }));

const hash = `0x${"a".repeat(64)}`;
const context = { params: Promise.resolve({ hash }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOrder.mockResolvedValue({ signature: "0xabcd" });
});

describe("native signed order lookup", () => {
  it("keeps source-less legacy requests on canonical Seaport storage", async () => {
    const response = await GET(
      new Request(`https://gnars.com/api/marketplace/orders/${hash}`),
      context,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ listing: { signature: "0xabcd" } });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.getOrder).toHaveBeenCalledExactlyOnceWith(hash, "gnars");
  });

  it.each(["gnars", "gnars-contract"] as const)(
    "partitions identical hashes by explicit %s source",
    async (source) => {
      const response = await GET(
        new Request(`https://gnars.com/api/marketplace/orders/${hash}?source=${source}`),
        context,
      );
      expect(response.status).toBe(200);
      expect(mocks.getOrder).toHaveBeenCalledExactlyOnceWith(hash, source);
    },
  );

  it.each(["opensea", "arbitrary-contract", ""])(
    "rejects unsupported source %s before storage access",
    async (source) => {
      const response = await GET(
        new Request(`https://gnars.com/api/marketplace/orders/${hash}?source=${source}`),
        context,
      );
      expect(response.status).toBe(400);
      expect(mocks.getOrder).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed order hashes before storage access", async () => {
    const response = await GET(
      new Request("https://gnars.com/api/marketplace/orders/not-a-hash?source=gnars-contract"),
      { params: Promise.resolve({ hash: "not-a-hash" }) },
    );
    expect(response.status).toBe(400);
    expect(mocks.getOrder).not.toHaveBeenCalled();
  });

  it("does not fall back to legacy storage if a custom order is missing", async () => {
    mocks.getOrder.mockRejectedValueOnce(new RequestSecurityError(404, "Listing was not found."));
    const response = await GET(
      new Request(`https://gnars.com/api/marketplace/orders/${hash}?source=gnars-contract`),
      context,
    );
    expect(response.status).toBe(404);
    expect(mocks.getOrder).toHaveBeenCalledExactlyOnceWith(hash, "gnars-contract");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
