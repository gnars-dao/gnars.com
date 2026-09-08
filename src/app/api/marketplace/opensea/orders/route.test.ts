import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequestSecurityError } from "@/lib/server/request-security";
import { MarketplaceServiceError } from "@/services/marketplace-common";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({ publish: vi.fn(), invalidate: vi.fn() }));
vi.mock("@/services/marketplace-opensea", () => ({
  publishOpenSeaListing: mocks.publish,
  invalidateOpenSeaOrdersCache: mocks.invalidate,
}));
beforeEach(() => vi.clearAllMocks());

function request(body: unknown) {
  return new Request("https://gnars.com/api/marketplace/opensea/orders", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("OpenSea posting request boundaries", () => {
  it("returns typed non-retryable diagnostics and a correlation ID without raw provider data", async () => {
    mocks.publish.mockRejectedValueOnce(
      new MarketplaceServiceError(422, "Order rejected.", "OPENSEA_ORDER_REJECTED", false),
    );
    const response = await POST(request({ listing: {} }));
    const body = await response.json();
    expect(response.status).toBe(422);
    expect(body).toMatchObject({
      error: "Order rejected.",
      code: "OPENSEA_ORDER_REJECTED",
      retryable: false,
      requestId: expect.any(String),
    });
    expect(response.headers.get("x-request-id")).toBe(body.requestId);
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
  it("rejects oversized and extra-field requests before provider work", async () => {
    expect((await POST(request({ listing: "x".repeat(25000) }))).status).toBe(413);
    expect((await POST(request({ listing: {}, url: "https://attacker.example" }))).status).toBe(
      400,
    );
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("invalidates only OpenSea orders after verified publication", async () => {
    const offer = { id: "opensea:verified", orderHash: `0x${"a".repeat(64)}` };
    mocks.publish.mockResolvedValueOnce(offer);
    const response = await POST(request({ listing: {} }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ offer });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith(offer.orderHash);
  });
  it("does not invalidate caches when provider acceptance is unconfirmed", async () => {
    mocks.publish.mockRejectedValueOnce(
      new RequestSecurityError(503, "Publication unconfirmed.", 30),
    );
    const response = await POST(request({ listing: {} }));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
});
