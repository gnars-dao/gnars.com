import { beforeEach, describe, expect, it, vi } from "vitest";
import { marketplaceUnavailable } from "@/services/marketplace-common";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({ facets: vi.fn(), rate: vi.fn() }));
vi.mock("@/services/marketplace-trait-index", () => ({ getMarketplaceTraitFacets: mocks.facets }));
vi.mock("@/lib/server/request-security", async (original) => ({
  ...(await original<typeof import("@/lib/server/request-security")>()),
  enforceRateLimit: mocks.rate,
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.facets.mockResolvedValue({ total: 6006, traits: [] });
});
describe("trait facets endpoint", () => {
  it("returns cached facets with a bounded read budget", async () => {
    const response = await GET(new Request("https://gnars.com/api/marketplace/trait-facets"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=60");
    expect(await response.json()).toEqual({ total: 6006, traits: [] });
    expect(mocks.rate.mock.calls[0][1]).toEqual({
      scope: "marketplace-trait-facets",
      limit: 30,
      windowSeconds: 60,
    });
  });
  it.each(["snapshotId=invalid", "collection=other", "snapshotId="])(
    "rejects invalid query %s",
    async (query) => {
      expect(
        (await GET(new Request(`https://gnars.com/api/marketplace/trait-facets?${query}`))).status,
      ).toBe(400);
      expect(mocks.facets).not.toHaveBeenCalled();
    },
  );
  it("forwards an exact historical snapshot", async () => {
    const hash = `0x${"a".repeat(64)}`;
    await GET(new Request(`https://gnars.com/api/marketplace/trait-facets?snapshotId=${hash}`));
    expect(mocks.facets).toHaveBeenCalledWith(hash);
  });
  it("returns unavailable with no-store instead of empty facets", async () => {
    mocks.facets.mockRejectedValue(
      marketplaceUnavailable("Marketplace trait snapshot is unavailable."),
    );
    const response = await GET(new Request("https://gnars.com/api/marketplace/trait-facets"));
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      code: "MARKETPLACE_UNAVAILABLE",
      retryable: true,
    });
  });
});
