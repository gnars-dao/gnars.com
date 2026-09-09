import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const load = vi.hoisted(() => vi.fn());
vi.mock("@/services/swap-token-directory", () => ({ getSwapTokenDirectory: load }));
beforeEach(() => {
  load.mockReset().mockResolvedValue({
    tokens: [],
    sources: {
      zora: { available: true },
      clanker: { available: true },
      stocks: { available: true },
    },
  });
});
describe("swap token directory request boundary", () => {
  it.each([
    "chainId=1",
    "chainId=8453&chainId=1",
    "chainId=8453&q=unbounded",
    "url=https://attacker.example",
  ])("rejects unsupported or unbounded inputs before provider requests: %s", async (query) => {
    expect((await GET(new Request(`https://gnars.com/api/swap/tokens?${query}`))).status).toBe(400);
    expect(load).not.toHaveBeenCalled();
  });
  it("shares a successful Base directory across visitors", async () => {
    const response = await GET(new Request("https://gnars.com/api/swap/tokens?chainId=8453"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, s-maxage=300, stale-while-revalidate=300",
    );
  });
  it("keeps partial failure visible and out of CDN success caches", async () => {
    load.mockResolvedValueOnce({
      tokens: [],
      sources: {
        zora: { available: false },
        clanker: { available: true },
        stocks: { available: true },
      },
    });
    const response = await GET(new Request("https://gnars.com/api/swap/tokens"));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ sources: { zora: { available: false } } });
  });
});
