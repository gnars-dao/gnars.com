import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({ list: vi.fn(), rate: vi.fn() }));
vi.mock("@/services/marketplace-community", () => ({ listCommunityManagedOrders: mocks.list }));
vi.mock("@/lib/server/request-security", async (original) => ({
  ...(await original<typeof import("@/lib/server/request-security")>()),
  enforceRateLimit: mocks.rate,
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rate.mockResolvedValue(undefined);
  mocks.list.mockResolvedValue({ items: [], nextCursor: null, available: true });
});
describe("private community seller route", () => {
  it.each([null, "invalid-json", "x".repeat(20001)])(
    "rejects missing, malformed and oversized authorization",
    async (value) => {
      const request = new Request("https://gnars.com/api/marketplace/community/manage", {
        headers: value === null ? {} : { "x-wallet-authorization": value },
      });
      expect((await GET(request)).status).toBe(401);
      expect(mocks.list).not.toHaveBeenCalled();
    },
  );
  it.each([
    "owner=0x1111111111111111111111111111111111111111",
    "seller=0x1111111111111111111111111111111111111111",
    "cursor=invalid",
  ])("rejects claimed seller identities or invalid cursor: %s", async (query) => {
    const request = new Request(`https://gnars.com/api/marketplace/community/manage?${query}`, {
      headers: { "x-wallet-authorization": "{}" },
    });
    expect((await GET(request)).status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("passes only authorization and bounded cursor without caching private results", async () => {
    const authorization = { signature: "0x12" };
    const request = new Request("https://gnars.com/api/marketplace/community/manage?cursor=25", {
      headers: { "x-wallet-authorization": JSON.stringify(authorization) },
    });
    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.list).toHaveBeenCalledWith(authorization, "25");
  });
});
