import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequestSecurityError } from "@/lib/server/request-security";
import { marketplaceUnavailable } from "@/services/marketplace-common";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({ rate: vi.fn(), provider: vi.fn() }));
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock("@/lib/server/request-security", async (original) => ({
  ...(await original<typeof import("@/lib/server/request-security")>()),
  enforceRateLimit: mocks.rate,
}));
vi.mock("@/services/marketplace-opensea", () => ({ requestOpenSeaNftActivity: mocks.provider }));
const collection = "0x880fb3cf5c6cc2d7dfc13a993e839a9411200c17";
const params = { collection, tokenId: "1830" };
const request = (query: Record<string, string>) =>
  new Request(`https://gnars.com/api/marketplace/activity?${new URLSearchParams(query)}`);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.provider.mockResolvedValue({ asset_events: [], next: null });
});

describe("marketplace activity GET", () => {
  it("returns a short cached, explicitly indexed history", async () => {
    const req = request(params);
    const response = await GET(req);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      collectionAddress: collection,
      tokenId: "1830",
      events: [],
      nextCursor: null,
      source: "opensea",
    });
    expect(response.headers.get("cache-control")).toBe(
      "public, s-maxage=30, stale-while-revalidate=30",
    );
    expect(mocks.rate).toHaveBeenCalledWith(req, {
      scope: "marketplace-activity",
      limit: 30,
      windowSeconds: 60,
    });
  });
  it.each([
    {},
    { ...params, collection: "invalid" },
    { ...params, tokenId: "-1" },
    { ...params, cursor: "bad" },
    { ...params, chain: "ethereum" },
    { ...params, limit: "200" },
  ])("rejects invalid or unsupported queries", async (query) => {
    const response = await GET(request(query));
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.provider).not.toHaveBeenCalled();
  });
  it("keeps provider failure explicit and uncached", async () => {
    mocks.provider.mockRejectedValue(marketplaceUnavailable());
    const response = await GET(request(params));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      retryable: true,
      code: "MARKETPLACE_UNAVAILABLE",
    });
  });
  it("rate limits before fetching upstream", async () => {
    mocks.rate.mockRejectedValueOnce(new RequestSecurityError(429, "Too many requests.", 60));
    const response = await GET(request(params));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(mocks.provider).not.toHaveBeenCalled();
  });
});
