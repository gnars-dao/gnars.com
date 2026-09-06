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
    expect(mocks.reconcile).toHaveBeenCalledWith(orderHash);
    expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith("marketplace-orders", { expire: 0 });
  });
});
