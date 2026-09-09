import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAO_ADDRESSES } from "@/lib/config";
import { swapTokenDirectorySchema } from "@/lib/swap-token-directory";
import { getSwapTokenDirectory } from "./swap-token-directory";

const mocks = vi.hoisted(() => ({ zora: vi.fn(), fetch: vi.fn(), cacheOptions: [] as unknown[] }));
vi.mock("@zoralabs/coins-sdk", () => ({ getCoinsTopVolume24h: mocks.zora, setApiKey: vi.fn() }));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: unknown, _keys: unknown, options: unknown) => {
    mocks.cacheOptions.push(options);
    return fn;
  },
}));
let now = Date.now();
const address = "0x1111111111111111111111111111111111111111";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  now += 100_000;
  vi.setSystemTime(now);
  mocks.zora.mockReset().mockResolvedValue({ data: { exploreList: { edges: [] } } });
  mocks.fetch.mockReset().mockImplementation(async () =>
    Response.json({
      data: [
        {
          contract_address: address,
          name: "Community",
          symbol: "COMM",
          chain_id: 8453,
          type: "clanker_v4",
          factory_address: address,
        },
      ],
    }),
  );
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("shared swap token directory", () => {
  it("includes only explicitly verified Base stocks with their actual eight decimals", async () => {
    const directory = await getSwapTokenDirectory();
    expect(swapTokenDirectorySchema.safeParse(directory).success).toBe(true);
    const stocks = directory.tokens.filter((token) => token.category === "stock");
    expect(stocks).toHaveLength(13);
    expect(directory.sources.stocks.available).toBe(true);
    expect(stocks.every((token) => token.decimals === 8 && token.source === "coinbase")).toBe(true);
    expect(stocks.find((token) => token.symbol === "AAPLc")?.address.toLowerCase()).toBe(
      "0xb200000000000000000000c2e324d24d7eecd1fb",
    );
    expect(stocks.every((token) => token.sourceUrl?.startsWith("https://docs.base.org/"))).toBe(
      true,
    );
  });
  it("shares 5-minute caches and concurrent cold misses without per-token calls", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => getSwapTokenDirectory()));
    expect(results).toHaveLength(20);
    expect(mocks.zora).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.cacheOptions).toEqual([{ revalidate: 300 }, { revalidate: 300 }]);
    expect(mocks.zora).toHaveBeenCalledWith(
      { count: 20 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://www.clanker.world/api/tokens?chainId=8453&limit=20&sortBy=tx-h24&sort=desc",
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
  });
  it("keeps known GNARS and successful providers while reporting partial failures", async () => {
    mocks.zora.mockRejectedValueOnce(new Error("quota"));
    const result = await getSwapTokenDirectory();
    expect(result.sources.zora.available).toBe(false);
    expect(result.sources.clanker.available).toBe(true);
    expect(result.tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ address: expect.any(String), source: "clanker" }),
        expect.objectContaining({ symbol: "GNARS", source: "zora" }),
      ]),
    );
    expect(result.tokens[0].address.toLowerCase()).toBe(DAO_ADDRESSES.gnarsErc20.toLowerCase());
    await getSwapTokenDirectory();
    expect(mocks.zora).toHaveBeenCalledTimes(1);
    vi.setSystemTime(now + 31_000);
    mocks.zora.mockResolvedValueOnce({ data: { exploreList: { edges: [] } } });
    expect((await getSwapTokenDirectory()).sources.zora.available).toBe(true);
  });
  it("does not cache invalid or failed reads as empty successful feeds", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
    mocks.zora.mockResolvedValueOnce({ data: {} });
    const result = await getSwapTokenDirectory();
    expect(result.sources.zora.available).toBe(false);
    expect(result.sources.clanker.available).toBe(false);
    expect(result.tokens.some((token) => token.symbol === "GNARS")).toBe(true);
  });
});
