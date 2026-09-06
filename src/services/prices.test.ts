import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEthUsd, getTokenPricesUsd } from "./prices";

const { cache, upstream } = vi.hoisted(() => ({
  cache: new Map<string, unknown>(),
  upstream: vi.fn(),
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
const a = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const b = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("shared USD price cache", () => {
  beforeEach(() => {
    cache.clear();
    upstream.mockReset();
    vi.stubGlobal("fetch", upstream);
    vi.stubEnv("COINGECKO_API_KEY", "test");
    vi.stubEnv("ALCHEMY_API_KEY", "test");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("canonicalizes order, casing, and duplicates before the cache boundary", async () => {
    upstream.mockResolvedValue(Response.json({ [a]: { usd: 1 }, [b]: { usd: 2 } }));
    expect(await getTokenPricesUsd([b, a], "base")).toEqual({ [a]: 1, [b]: 2 });
    expect(await getTokenPricesUsd([a.replace(/a/g, "A"), b, a], "base")).toEqual({
      [a]: 1,
      [b]: 2,
    });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(new URL(upstream.mock.calls[0][0]).searchParams.get("contract_addresses")).toBe(
      `${a},${b}`,
    );
  });

  it("does not cache token provider outages, and leaves unknowns null", async () => {
    upstream
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(Response.json({ [a]: { usd: 3 } }));
    expect(await getTokenPricesUsd([a, b], "base")).toEqual({ [a]: null, [b]: null });
    expect(await getTokenPricesUsd([a, b], "base")).toEqual({ [a]: 3, [b]: null });
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("does not cache failed ETH prices and attaches timeouts", async () => {
    upstream
      .mockResolvedValueOnce(Response.json({ error: "offline" }))
      .mockResolvedValueOnce(
        Response.json({ data: [{ symbol: "ETH", prices: [{ currency: "usd", value: "2000" }] }] }),
      );
    expect(await getEthUsd()).toBeNull();
    expect(await getEthUsd()).toBe(2000);
    expect(await getEthUsd()).toBe(2000);
    expect(upstream).toHaveBeenCalledTimes(2);
    for (const [, options] of upstream.mock.calls) {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.cache).toBe("no-store");
    }
  });

  it("rejects invalid addresses without requesting prices", async () => {
    await expect(getTokenPricesUsd(["bad"], "base")).rejects.toThrow(
      "Invalid token price addresses",
    );
    expect(upstream).not.toHaveBeenCalled();
  });
});
