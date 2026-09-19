import { beforeEach, describe, expect, it, vi } from "vitest";
import { marketplaceUnavailable } from "@/services/marketplace-common";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({ traits: vi.fn(), rate: vi.fn() }));
vi.mock("@/services/marketplace-traits", () => ({ getMarketplaceTraits: mocks.traits }));
vi.mock("@/lib/server/request-security", async (original) => ({
  ...(await original<typeof import("@/lib/server/request-security")>()),
  enforceRateLimit: mocks.rate,
}));
const collection = "0x1111111111111111111111111111111111111111";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.traits.mockResolvedValue({
    collectionAddress: collection,
    tokenId: "12",
    traits: [],
    source: "tokenURI",
  });
});
describe("traits endpoint", () => {
  it("validates identity, rate limits, and caches only successful detail responses", async () => {
    const response = await GET(
      new Request(`https://gnars.com/api/marketplace/traits?collection=${collection}&tokenId=12`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("s-maxage=300");
    expect(mocks.traits).toHaveBeenCalledWith(collection, "12");
    expect(mocks.rate).toHaveBeenCalledWith(expect.any(Request), {
      scope: "marketplace-traits",
      limit: 30,
      windowSeconds: 60,
    });
  });
  it.each([
    `collection=${collection}&tokenId=-1`,
    `collection=${collection}&tokenId=01`,
    `collection=${collection}&tokenId=${2n ** 256n}`,
    "collection=bad&tokenId=12",
    `collection=${collection}`,
    `collection=${collection}&tokenId=12&url=https://example.com`,
  ])("rejects malformed query %s", async (query) => {
    expect(
      (await GET(new Request(`https://gnars.com/api/marketplace/traits?${query}`))).status,
    ).toBe(400);
    expect(mocks.traits).not.toHaveBeenCalled();
  });
  it("does not cache provider failures or render them as empty traits", async () => {
    mocks.traits.mockRejectedValue(marketplaceUnavailable("NFT traits could not be loaded."));
    const response = await GET(
      new Request(`https://gnars.com/api/marketplace/traits?collection=${collection}&tokenId=12`),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).not.toHaveProperty("traits");
  });
});
