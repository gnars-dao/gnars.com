import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

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
const address = "0x1111111111111111111111111111111111111111";
let caller = 0;
const request = (query: string) =>
  new Request(`https://gnars.com/api/ens?${query}`, {
    headers: { "x-vercel-forwarded-for": `ens-test-${caller++}` },
  });
const post = (body: unknown) =>
  new Request("https://gnars.com/api/ens", {
    method: "POST",
    headers: { "x-vercel-forwarded-for": `ens-test-${caller++}` },
    body: JSON.stringify(body),
  });

describe("ENS request bounds and caching", () => {
  beforeEach(() => {
    cache.clear();
    upstream.mockReset();
    vi.stubGlobal("fetch", upstream);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("deduplicates batches and simultaneous lookups", async () => {
    upstream.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return Response.json({ name: "gnars.eth", avatar: null });
    });
    const [batch, single] = await Promise.all([
      POST(post({ addresses: [address, address] })),
      GET(request(`address=${address}`)),
    ]);
    expect(batch.status).toBe(200);
    expect(Object.keys((await batch.json()).ensMap)).toEqual([address]);
    expect(single.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect((await GET(request(`address=${address}`))).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid and oversized input before touching upstream", async () => {
    expect((await POST(post({ addresses: Array(51).fill(address) }))).status).toBe(400);
    expect((await POST(post({ addresses: [42] }))).status).toBe(400);
    expect((await POST(post({ name: "a".repeat(9000) }))).status).toBe(413);
    expect((await GET(request("name=bad"))).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("bounds batch concurrency to five", async () => {
    let active = 0;
    let peak = 0;
    upstream.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return Response.json({ name: null, avatar: null });
    });
    const addresses = Array.from(
      { length: 20 },
      (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`,
    );
    expect((await POST(post({ addresses }))).status).toBe(200);
    expect(peak).toBe(5);
    expect(upstream).toHaveBeenCalledTimes(20);
  });

  it("charges the rate limit by unique lookup count", async () => {
    upstream.mockImplementation(async () => Response.json({ name: null }));
    const addresses = Array.from(
      { length: 50 },
      (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`,
    );
    const source = `ens-budget-${caller++}`;
    const batch = (values: string[]) => {
      const req = post({ addresses: values });
      req.headers.set("x-vercel-forwarded-for", source);
      return req;
    };
    expect((await POST(batch(addresses))).status).toBe(200);
    expect((await POST(batch(addresses))).status).toBe(200);
    const limited = await POST(batch(addresses.slice(0, 21)));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(upstream).toHaveBeenCalledTimes(50);
  });

  it("does not cache provider failures as missing names", async () => {
    upstream
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ error: "unavailable" }))
      .mockResolvedValueOnce(Response.json({ name: "gnars.eth" }));
    const failed = await GET(request(`address=${address}`));
    expect(failed.status).toBe(502);
    expect(failed.headers.get("cache-control")).toBe("no-store");
    expect((await (await GET(request(`address=${address}`))).json()).ens.name).toBe("gnars.eth");
    expect(upstream).toHaveBeenCalledTimes(3);
    for (const [, options] of upstream.mock.calls) {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.cache).toBe("no-store");
    }
  });

  it("caches confirmed missing names, but retries failed forward lookups", async () => {
    upstream
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ address: null }));
    expect((await GET(request("name=missing.eth"))).status).toBe(502);
    expect(await (await GET(request("name=missing.eth"))).json()).toEqual({ address: null });
    expect(await (await GET(request("name=MISSING.ETH"))).json()).toEqual({ address: null });
    expect(upstream).toHaveBeenCalledTimes(3);
  });
});
