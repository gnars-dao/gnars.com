import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({ load: vi.fn(), rate: vi.fn() }));
vi.mock("@/services/marketplace", () => ({ loadMarketplacePage: mocks.load }));
vi.mock("@/lib/server/request-security", async (original) => ({
  ...(await original<typeof import("@/lib/server/request-security")>()),
  enforceRateLimit: mocks.rate,
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockResolvedValue({ items: [], nextCursor: null, sources: {} });
});
describe("marketplace price query", () => {
  it.each([
    "minPriceWei=2&maxPriceWei=1",
    "minPriceWei=-1",
    "minPriceWei=01",
    "maxPriceWei=1.1",
    "sort=price-desc",
    `maxPriceWei=${2n ** 256n}`,
  ])("rejects malformed bounds %s", async (query) => {
    expect((await GET(new Request(`https://gnars.com/api/marketplace?${query}`))).status).toBe(400);
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it("forwards exact prices without conversion to numbers", async () => {
    const response = await GET(
      new Request(
        "https://gnars.com/api/marketplace?sort=price-asc&minPriceWei=0&maxPriceWei=1000000000000000001",
      ),
    );
    expect(response.status).toBe(200);
    expect(mocks.load).toHaveBeenCalledWith({
      view: "listings",
      owner: undefined,
      sort: "price-asc",
      minPriceWei: "0",
      maxPriceWei: "1000000000000000001",
    });
  });
});
