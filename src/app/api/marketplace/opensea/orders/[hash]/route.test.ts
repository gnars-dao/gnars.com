import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequestSecurityError } from "@/lib/server/request-security";
import { GET } from "./route";

const order = vi.hoisted(() => vi.fn());
vi.mock("@/services/marketplace-opensea", () => ({ getOpenSeaCancellationOrder: order }));
beforeEach(() => vi.clearAllMocks());
const hash = `0x${"a".repeat(64)}`;
const request = new Request("https://gnars.com/api/marketplace/opensea/orders/hash");

describe("OpenSea cancellation order boundaries", () => {
  it("rejects malformed hashes before requesting a provider-owned path", async () => {
    const response = await GET(request, { params: Promise.resolve({ hash: "../collections" }) });
    expect(response.status).toBe(400);
    expect(order).not.toHaveBeenCalled();
  });
  it("returns verified order components without caching cancellation data", async () => {
    order.mockResolvedValueOnce({ order_hash: hash, status: "EXPIRED" });
    const response = await GET(request, { params: Promise.resolve({ hash }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ order: { order_hash: hash, status: "EXPIRED" } });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(order).toHaveBeenCalledExactlyOnceWith(hash);
  });
  it("preserves not-found without pretending an order was cancelled", async () => {
    order.mockRejectedValueOnce(new RequestSecurityError(404, "Listing was not found."));
    const response = await GET(request, { params: Promise.resolve({ hash }) });
    expect(response.status).toBe(404);
  });
});
