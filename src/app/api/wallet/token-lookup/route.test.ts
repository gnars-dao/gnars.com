import { NextRequest } from "next/server";
import { getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const { cache, upstream, coin } = vi.hoisted(() => ({
  cache: new Map<string, unknown>(),
  upstream: vi.fn(),
  coin: vi.fn(),
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
vi.mock("@zoralabs/coins-sdk", () => ({ getCoin: coin, setApiKey: vi.fn() }));
const token = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
let caller = 0;
const request = (address = token, chainId = 8453) =>
  new NextRequest(
    `https://gnars.com/api/wallet/token-lookup?address=${address}&chainId=${chainId}`,
    { headers: { "x-vercel-forwarded-for": `lookup-test-${caller++}` } },
  );
const metadata = { result: { name: "Token", symbol: "TOKEN", decimals: 18, logo: null } };

describe("token lookup caching", () => {
  beforeEach(() => {
    cache.clear();
    upstream.mockReset();
    coin.mockReset();
    vi.stubGlobal("fetch", upstream);
    vi.stubEnv("ALCHEMY_API_KEY", "test");
    upstream.mockImplementation(async () => Response.json(metadata));
    coin.mockResolvedValue({ data: { zora20Token: null } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("shares metadata and confirmed non-Zora lookups across casing and requests", async () => {
    const first = await GET(request());
    const second = await GET(request(getAddress(token)));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get("cache-control")).toContain("s-maxage=3600");
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(coin).toHaveBeenCalledTimes(1);
    expect(coin.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(upstream.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("does not cache a Zora outage as a missing logo", async () => {
    coin.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({
      data: { zora20Token: { mediaContent: { previewImage: "https://example.com/token.png" } } },
    });
    const degraded = await GET(request());
    expect(degraded.status).toBe(200);
    expect(degraded.headers.get("cache-control")).toBe("no-store");
    expect((await (await GET(request())).json()).logoUrl).toBe("https://example.com/token.png");
    expect(coin).toHaveBeenCalledTimes(2);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("rejects HTTP-200 RPC errors as upstream failures, not invalid tokens", async () => {
    upstream.mockResolvedValueOnce(Response.json({ error: { code: -32000 } }));
    const failed = await GET(request());
    expect(failed.status).toBe(502);
    expect(failed.headers.get("cache-control")).toBe("no-store");
    expect((await GET(request())).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("skips Zora outside Base and rejects invalid input", async () => {
    expect((await GET(request(token, 1))).status).toBe(200);
    expect(coin).not.toHaveBeenCalled();
    expect((await GET(request("bad"))).status).toBe(400);
    expect((await GET(request(token, 999))).status).toBe(400);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
