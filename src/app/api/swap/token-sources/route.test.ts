import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const load = vi.hoisted(() => vi.fn());
vi.mock("@/services/swap-token-sources", () => ({ getSwapTokenSources: load }));
const a = "0x1111111111111111111111111111111111111111";
const b = "0x2222222222222222222222222222222222222222";
const request = (query: string) => new Request(`https://gnars.com/api/swap/token-sources?${query}`);
beforeEach(() => {
  load.mockReset().mockResolvedValue({ tokens: [], complete: true });
});
describe("token sources request boundary", () => {
  it.each([
    "",
    `chainId=1&addresses=${a}`,
    "chainId=8453&addresses=invalid",
    `chainId=8453&addresses=${Array(26).fill(a).join(",")}`,
    `chainId=8453&addresses=${a}&chainId=8453`,
    `chainId=8453&addresses=${a}&extra=1`,
  ])("rejects invalid requests before upstream work: %s", async (query) => {
    expect((await GET(request(query))).status).toBe(400);
    expect(load).not.toHaveBeenCalled();
  });
  it("canonicalizes source lookups and caches complete public metadata", async () => {
    const response = await GET(request(`chainId=8453&addresses=${b},${a},${b}`));
    expect(load).toHaveBeenCalledWith([a, b]);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, s-maxage=3600");
  });
  it("never caches partial metadata as successful absence", async () => {
    load.mockResolvedValueOnce({ tokens: [{ address: a, source: "zora" }], complete: false });
    const response = await GET(request(`chainId=8453&addresses=${a}`));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ complete: false });
  });
});
