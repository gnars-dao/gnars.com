import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequestSecurityError } from "@/lib/server/request-security";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({ budget: vi.fn(), save: vi.fn() }));
vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));
vi.mock("@/services/marketplace-orders", () => ({
  enforceMarketplaceBudget: mocks.budget,
  saveMarketplaceOrder: mocks.save,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.budget.mockResolvedValue(undefined);
});

describe("listing creation request boundaries", () => {
  it("rejects oversized signed-order payloads before signature or RPC work", async () => {
    const response = await POST(
      new Request("https://gnars.com/api/marketplace/orders", {
        method: "POST",
        body: JSON.stringify({ listing: "x".repeat(25000) }),
      }),
    );
    expect(response.status).toBe(413);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("stops expensive validation when the distributed budget is exhausted", async () => {
    mocks.budget.mockRejectedValueOnce(new RequestSecurityError(429, "Limit reached.", 30));
    const response = await POST(
      new Request("https://gnars.com/api/marketplace/orders", {
        method: "POST",
        body: JSON.stringify({ listing: {} }),
      }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
