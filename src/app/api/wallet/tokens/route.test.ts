import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const { cache, upstream, getCoins } = vi.hoisted(() => ({
  cache: new Map<string, unknown>(),
  upstream: vi.fn(),
  getCoins: vi.fn(),
}));
vi.mock("next/cache", () => ({
  unstable_cache:
    (fn: (...args: unknown[]) => Promise<unknown>, keys: string[]) =>
    async (...args: unknown[]) => {
      const key = JSON.stringify([keys, args]);
      if (cache.has(key)) return cache.get(key);
      const value = await fn(...args);
      cache.set(key, value);
      return value;
    },
}));
vi.mock("@zoralabs/coins-sdk", () => ({ getCoins, setApiKey: vi.fn() }));

const wallet = "0x1111111111111111111111111111111111111111";
const token = "0x2222222222222222222222222222222222222222";
const metadata = { name: "Token", symbol: "TOKEN", decimals: 18, logo: null };
const balances = (addresses = [token]) => ({
  id: 1,
  jsonrpc: "2.0",
  result: {
    tokenBalances: addresses.map((contractAddress) => ({
      contractAddress,
      tokenBalance: "0xde0b6b3a7640000",
    })),
  },
});
const request = () =>
  new NextRequest(`https://gnars.com/api/wallet/tokens?address=${wallet}&chainId=1`);

describe("wallet token provider failures", () => {
  beforeEach(() => {
    cache.clear();
    upstream.mockReset();
    vi.stubGlobal("fetch", upstream);
    vi.stubEnv("ALCHEMY_API_KEY", "test-only-key");
    vi.stubEnv("COINGECKO_API_KEY", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects HTTP-200 balance errors and retries instead of caching an empty wallet", async () => {
    upstream
      .mockResolvedValueOnce(Response.json({ id: 1, error: { code: -32000 } }))
      .mockResolvedValueOnce(Response.json(balances([])));
    const failed = await GET(request());
    expect(failed.status).toBe(502);
    expect(failed.headers.get("cache-control")).toBe("no-store");
    expect(await (await GET(request())).json()).toEqual([]);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("does not cache failed metadata or turn it into an empty token list", async () => {
    upstream
      .mockResolvedValueOnce(Response.json(balances()))
      .mockResolvedValueOnce(Response.json([{ id: 1, error: { code: -32000 } }]))
      .mockResolvedValueOnce(Response.json([{ id: 1, result: metadata }]));
    expect((await GET(request())).status).toBe(502);
    const recovered = await GET(request());
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject([{ address: token, symbol: "TOKEN" }]);
    expect((await GET(request())).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(3);
    for (const [, options] of upstream.mock.calls) {
      expect(options.cache).toBe("no-store");
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.next).toBeUndefined();
    }
  });

  it.each([
    { invalid: [] },
    { invalid: [{ id: 1 }] },
    { invalid: [{ result: metadata }] },
    { invalid: [{ id: 2, result: metadata }] },
    {
      invalid: [
        { id: 1, result: metadata },
        { id: 1, result: metadata },
      ],
    },
  ])("rejects incomplete or malformed metadata batches: $invalid", async ({ invalid }) => {
    upstream
      .mockResolvedValueOnce(Response.json(balances()))
      .mockResolvedValueOnce(Response.json(invalid));
    const response = await GET(request());
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("limits metadata batches to 25 tokens and matches out-of-order response IDs", async () => {
    const addresses = Array.from(
      { length: 26 },
      (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`,
    );
    upstream.mockImplementation(async (_url, options) => {
      const body = JSON.parse(options.body);
      if (!Array.isArray(body)) return Response.json(balances(addresses));
      return Response.json(
        body.map((entry: { id: number }) => ({ id: entry.id, result: metadata })).reverse(),
      );
    });
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveLength(26);
    const batches = upstream.mock.calls
      .map(([, options]) => JSON.parse(options.body))
      .filter(Array.isArray);
    expect(batches.map((batch) => batch.length)).toEqual([25, 1]);
  });

  it("sets a timeout on CoinGecko requests as well as RPC reads", async () => {
    vi.stubEnv("COINGECKO_API_KEY", "test-only-key");
    upstream.mockImplementation(async (url, options) => {
      if (url.includes("coingecko")) {
        expect(options.signal).toBeInstanceOf(AbortSignal);
        return Response.json({ [token]: { usd: 1 } });
      }
      const body = JSON.parse(options.body);
      return Response.json(Array.isArray(body) ? [{ id: 1, result: metadata }] : balances());
    });
    expect((await GET(request())).status).toBe(200);
    expect(upstream.mock.calls.some(([url]) => url.includes("coingecko"))).toBe(true);
  });
});
