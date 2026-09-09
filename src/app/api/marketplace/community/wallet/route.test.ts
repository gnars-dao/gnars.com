import { getAddress, zeroAddress } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequestSecurityError } from "@/lib/server/request-security";
import { marketplaceUnavailable } from "@/services/marketplace-common";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({ rate: vi.fn(), inventory: vi.fn() }));
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock("@/lib/server/request-security", async (original) => ({
  ...(await original<typeof import("@/lib/server/request-security")>()),
  enforceRateLimit: mocks.rate,
}));
vi.mock("@/services/marketplace-wallet-nfts", async (original) => ({
  ...(await original<typeof import("@/services/marketplace-wallet-nfts")>()),
  getMarketplaceWalletNfts: mocks.inventory,
}));
const owner = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
function request(params: Record<string, string>) {
  return new Request(
    `https://gnars.com/api/marketplace/community/wallet?${new URLSearchParams(params)}`,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rate.mockResolvedValue(undefined);
  mocks.inventory.mockResolvedValue({ items: [], nextCursor: null });
});
describe("community wallet route", () => {
  it("accepts the selected wallet and bounded opaque cursor without authorization", async () => {
    const req = request({ owner, cursor: "opaque+/page==" });
    const response = await GET(req);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [], nextCursor: null });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.inventory).toHaveBeenCalledWith(getAddress(owner), "opaque+/page==");
    expect(mocks.rate).toHaveBeenCalledWith(req, {
      scope: "community-wallet",
      limit: 30,
      windowSeconds: 60,
    });
  });
  it.each<Record<string, string>>([
    {},
    { owner: "invalid" },
    { owner: zeroAddress },
    { owner, cursor: "" },
    { owner, cursor: "a".repeat(1025) },
    { owner, cursor: "line\nbreak" },
    { owner, admin: owner },
    { owner, chainId: "1" },
    { owner, pageSize: "100" },
  ])("rejects invalid or unsupported query fields", async (params) => {
    const response = await GET(request(params));
    expect(response.status).toBe(400);
    expect(mocks.inventory).not.toHaveBeenCalled();
  });
  it("returns explicit upstream errors instead of an empty inventory", async () => {
    mocks.inventory.mockRejectedValueOnce(
      marketplaceUnavailable("Wallet NFTs could not be loaded. Try again."),
    );
    const response = await GET(request({ owner }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "MARKETPLACE_UNAVAILABLE",
      retryable: true,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("enforces the rate limit before provider access", async () => {
    mocks.rate.mockRejectedValueOnce(new RequestSecurityError(429, "Too many requests.", 60));
    const response = await GET(request({ owner }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(mocks.inventory).not.toHaveBeenCalled();
  });
});
