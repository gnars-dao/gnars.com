import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequestSecurityError } from "@/lib/server/request-security";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({ budget: vi.fn(), prepare: vi.fn() }));
vi.mock("@/services/marketplace-orders", () => ({ enforceMarketplaceBudget: mocks.budget }));
vi.mock("@/services/marketplace-fulfillment", async (original) => ({
  ...(await original<typeof import("@/services/marketplace-fulfillment")>()),
  prepareMarketplaceFulfillment: mocks.prepare,
}));

const input = {
  source: "opensea",
  orderHash: `0x${"a".repeat(64)}`,
  tokenId: "12",
  buyer: "0x1111111111111111111111111111111111111111",
  expectedPriceWei: "100",
};
function request(body: unknown) {
  return new Request("https://gnars.com/api/marketplace/fulfillment", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.prepare.mockResolvedValue({ transaction: { value: "100", chainId: 8453 } });
  mocks.budget.mockResolvedValue(undefined);
});

describe("marketplace fulfillment request budgets", () => {
  it("does not require local order storage to prepare an OpenSea purchase", async () => {
    mocks.budget.mockRejectedValueOnce(new Error("No database"));
    const response = await POST(request(input));
    expect(response.status).toBe(200);
    expect(mocks.budget).not.toHaveBeenCalled();
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(input);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("keeps the durable storage budget for a local-order purchase", async () => {
    mocks.budget.mockRejectedValueOnce(new RequestSecurityError(503, "No database"));
    const response = await POST(request({ ...input, source: "gnars" }));
    expect(response.status).toBe(503);
    expect(mocks.budget).toHaveBeenCalledWith(expect.anything(), "fulfillment");
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it("rejects invalid input before either budget or upstream work", async () => {
    const response = await POST(request({ ...input, expectedPriceWei: "-1" }));
    expect(response.status).toBe(400);
    expect(mocks.budget).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it("propagates provider budget exhaustion with retry timing", async () => {
    mocks.prepare.mockRejectedValueOnce(new RequestSecurityError(429, "OpenSea limit reached", 25));
    const response = await POST(request(input));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("25");
  });
});
