import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({ budget: vi.fn(), reconcile: vi.fn(), invalidate: vi.fn() }));
vi.mock("next/cache", () => ({ revalidateTag: mocks.invalidate }));
vi.mock("@/services/marketplace-orders", () => ({
  enforceMarketplaceBudget: mocks.budget,
  reconcileMarketplaceOrder: mocks.reconcile,
}));

const orderHash = `0x${"a".repeat(64)}`;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.budget.mockResolvedValue(undefined);
});

describe("chain-only listing reconciliation", () => {
  it("reconciles the explicit custom source without redirecting an identical hash to legacy storage", async () => {
    mocks.reconcile.mockResolvedValue({ status: "cancelled" });
    const request = new Request("https://gnars.com/api/marketplace/reconcile", {
      method: "POST",
      body: JSON.stringify({ orderHash, source: "gnars-contract" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "cancelled" });
    expect(mocks.budget).toHaveBeenCalledExactlyOnceWith(request, "reconcile");
    expect(mocks.reconcile).toHaveBeenCalledExactlyOnceWith(orderHash, "gnars-contract");
    expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith("marketplace-orders", { expire: 0 });
  });
  it.each(["opensea", "arbitrary-contract", ""])(
    "rejects invalid source %s before chain reads and cache invalidation",
    async (source) => {
      const response = await POST(
        new Request("https://gnars.com/api/marketplace/reconcile", {
          method: "POST",
          body: JSON.stringify({ orderHash, source }),
        }),
      );
      expect(response.status).toBe(400);
      expect(mocks.budget).not.toHaveBeenCalled();
      expect(mocks.reconcile).not.toHaveBeenCalled();
      expect(mocks.invalidate).not.toHaveBeenCalled();
    },
  );
  it("does not invalidate or fall back to legacy when custom reconciliation fails", async () => {
    mocks.reconcile.mockRejectedValueOnce(new Error("Custom deployment unavailable"));
    const response = await POST(
      new Request("https://gnars.com/api/marketplace/reconcile", {
        method: "POST",
        body: JSON.stringify({ orderHash, source: "gnars-contract" }),
      }),
    );
    expect(response.status).toBe(500);
    expect(mocks.reconcile).toHaveBeenCalledExactlyOnceWith(orderHash, "gnars-contract");
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
  it("rejects forged client filled/cancelled status instead of mutating an order", async () => {
    const response = await POST(
      new Request("https://gnars.com/api/marketplace/reconcile", {
        method: "POST",
        body: JSON.stringify({ orderHash, status: "filled" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.budget).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
  it("returns only the status read from chain and invalidates successful reconciliation", async () => {
    mocks.reconcile.mockResolvedValue({ status: "active" });
    const response = await POST(
      new Request("https://gnars.com/api/marketplace/reconcile", {
        method: "POST",
        body: JSON.stringify({ orderHash }),
      }),
    );
    expect(await response.json()).toEqual({ status: "active" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.reconcile).toHaveBeenCalledWith(orderHash, "gnars");
    expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith("marketplace-orders", { expire: 0 });
  });
});
