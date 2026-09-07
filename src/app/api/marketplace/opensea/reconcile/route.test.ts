import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({ reconcile: vi.fn(), invalidate: vi.fn() }));
vi.mock("@/services/marketplace-opensea", () => ({
  reconcileOpenSeaOrder: mocks.reconcile,
  invalidateOpenSeaOrdersCache: mocks.invalidate,
}));
beforeEach(() => vi.clearAllMocks());
const hash = `0x${"a".repeat(64)}`;
function request(body: unknown) {
  return new Request("https://gnars.com/api/marketplace/opensea/reconcile", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("OpenSea reconciliation boundaries", () => {
  it("rejects malformed or oversized payloads before RPC work", async () => {
    expect((await POST(request({ orderHash: "invalid" }))).status).toBe(400);
    expect((await POST(request({ orderHash: hash, status: "cancelled" }))).status).toBe(400);
    expect((await POST(request({ orderHash: "x".repeat(2000) }))).status).toBe(413);
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });
  it("does not let an active or nonexistent order flush caches", async () => {
    mocks.reconcile.mockResolvedValueOnce({ status: "active" });
    expect((await POST(request({ orderHash: hash }))).status).toBe(200);
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
  it.each(["cancelled", "filled"])(
    "invalidates only OpenSea orders after confirmed %s",
    async (status) => {
      mocks.reconcile.mockResolvedValueOnce({ status });
      const response = await POST(request({ orderHash: hash }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status });
      expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith(hash);
    },
  );
  it("does not turn an RPC failure into a final order status", async () => {
    mocks.reconcile.mockRejectedValueOnce(new Error("RPC offline"));
    expect((await POST(request({ orderHash: hash }))).status).toBe(500);
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
});
