import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequestSecurityError } from "@/lib/server/request-security";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({ budget: vi.fn(), service: vi.fn(), limit: vi.fn() }));
vi.mock("@/services/marketplace-orders", () => ({ enforceMarketplaceBudget: mocks.budget }));
vi.mock("@/lib/server/request-security", async (original) => ({
  ...(await original<typeof import("@/lib/server/request-security")>()),
  enforceRateLimit: mocks.limit,
}));
vi.mock("@/services/marketplace-mixed-sweep", async (original) => ({
  ...(await original<typeof import("@/services/marketplace-mixed-sweep")>()),
  quoteMixedMarketplaceSweep: mocks.service,
}));
const buyer = "0x1111111111111111111111111111111111111111";
const input = { buyer, quantity: 2 };
const request = (body: unknown) =>
  new Request("https://gnars.com/api/marketplace/sweep/plan", {
    method: "POST",
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.service.mockResolvedValue({ totalWei: "100" });
});
describe("mixed sweep route", () => {
  it("applies both budgets before provider work and never caches wallet plans", async () => {
    const response = await POST(request(input));
    expect(response.status).toBe(200);
    expect(mocks.limit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: "marketplace-sweep-quote" }),
    );
    expect(mocks.budget).toHaveBeenCalledWith(expect.anything(), "reconcile");
    expect(mocks.service).toHaveBeenCalledExactlyOnceWith(input);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("rejects extra targets and invalid input before paid work", async () => {
    for (const body of [
      { ...input, buyer: "invalid" },
      { ...input, to: buyer },
      { ...input, quantity: 11 },
    ])
      expect((await POST(request(body))).status).toBe(400);
    expect(mocks.service).not.toHaveBeenCalled();
    expect(mocks.budget).not.toHaveBeenCalled();
  });
  it("fails closed when budget is exhausted", async () => {
    mocks.budget.mockRejectedValueOnce(new RequestSecurityError(429, "Limit reached", 30));
    const response = await POST(request(input));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(mocks.service).not.toHaveBeenCalled();
  });
});
