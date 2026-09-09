import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequestSecurityError } from "@/lib/server/request-security";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({ budget: vi.fn(), service: vi.fn(), limit: vi.fn() }));
vi.mock("@/services/marketplace-orders", () => ({ enforceMarketplaceBudget: mocks.budget }));
vi.mock("@/lib/server/request-security", async (original) => ({
  ...(await original<typeof import("@/lib/server/request-security")>()),
  enforceRateLimit: mocks.limit,
}));
vi.mock("@/services/marketplace-sweep", async (original) => ({
  ...(await original<typeof import("@/services/marketplace-sweep")>()),
  prepareMarketplaceSweep: mocks.service,
}));
const buyer = "0x1111111111111111111111111111111111111111";
const input = {
  buyer,
  selections: [{ orderHash: `0x${"a".repeat(64)}`, tokenId: "42", priceWei: "100" }],
  maxTotalWei: "100",
};
function request(body: unknown) {
  return new Request("https://gnars.com/api/marketplace/sweep/fulfillment", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.service.mockResolvedValue({ totalWei: "100" });
});
describe("sweep fulfillment route", () => {
  it("uses durable and local budgets before service; never caches wallet data", async () => {
    const response = await POST(request(input));
    expect(response.status).toBe(200);
    expect(mocks.budget).toHaveBeenCalledWith(expect.anything(), "fulfillment");
    expect(mocks.service).toHaveBeenCalledExactlyOnceWith(input);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("rejects malformed input before paid work", async () => {
    expect((await POST(request({ ...input, buyer: "invalid" }))).status).toBe(400);
    expect(mocks.budget).not.toHaveBeenCalled();
    expect(mocks.service).not.toHaveBeenCalled();
  });
  it("fails closed if durable budget is unavailable", async () => {
    mocks.budget.mockRejectedValueOnce(new RequestSecurityError(429, "Limit reached", 30));
    const response = await POST(request(input));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(mocks.service).not.toHaveBeenCalled();
  });
});
