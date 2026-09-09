import type { Address } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSwapTokenSources } from "./swap-token-sources";

const mocks = vi.hoisted(() => ({
  zora: vi.fn(),
  fetch: vi.fn(),
  cache: new Map<string, unknown>(),
  options: [] as unknown[],
}));
vi.mock("@zoralabs/coins-sdk", () => ({ getCoins: mocks.zora, setApiKey: vi.fn() }));
vi.mock("next/cache", () => ({
  unstable_cache: (
    fn: (...args: unknown[]) => Promise<unknown>,
    keys: string[],
    options: unknown,
  ) => {
    mocks.options.push(options);
    return async (...args: unknown[]) => {
      const key = JSON.stringify([keys, args]);
      if (mocks.cache.has(key)) return mocks.cache.get(key);
      const result = await fn(...args);
      mocks.cache.set(key, result);
      return result;
    };
  },
}));
const address = (index: number) => `0x${index.toString(16).padStart(40, "0")}` as Address;
const a = address(1);
const b = address(2);
const token = (contract_address: Address) => ({
  contract_address,
  chain_id: 8453,
  factory_address: address(100),
  type: "clanker_v4",
});
beforeEach(() => {
  mocks.cache.clear();
  mocks.zora.mockReset().mockResolvedValue({ data: { zora20Tokens: [] } });
  mocks.fetch.mockReset().mockImplementation(async () => Response.json({ data: [] }));
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("wallet token source enrichment service", () => {
  it("batches Zora, looks up only unknown tokens, and shares canonical requests", async () => {
    mocks.zora.mockResolvedValue({ data: { zora20Tokens: [{ address: a, chainId: 8453 }] } });
    mocks.fetch.mockImplementation(async () => Response.json({ data: [token(b)] }));
    const results = await Promise.all([
      getSwapTokenSources([b, a]),
      getSwapTokenSources([a, b, a]),
    ]);
    expect(results[0]).toEqual({
      tokens: [
        { address: a, source: "zora" },
        { address: b, source: "clanker" },
      ],
      complete: true,
    });
    expect(results[1]).toEqual(results[0]);
    expect(mocks.zora).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.zora).toHaveBeenCalledWith(
      { coins: [a, b].map((collectionAddress) => ({ collectionAddress, chainId: 8453 })) },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.fetch).toHaveBeenCalledWith(
      `https://www.clanker.world/api/tokens?chainId=8453&q=${b}&limit=20`,
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
    expect(mocks.options).toEqual([{ revalidate: 3600 }, { revalidate: 3600 }]);
  });
  it("never fans a failed Zora batch out into Clanker lookups or caches the failure", async () => {
    mocks.zora.mockRejectedValueOnce(new Error("rate limited"));
    expect(await getSwapTokenSources([a, b])).toEqual({ tokens: [], complete: false });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(await getSwapTokenSources([a, b])).toEqual({ tokens: [], complete: true });
    expect(mocks.zora).toHaveBeenCalledTimes(2);
  });
  it("continues mixed-wallet lookup when Zora returns null for a Clanker contract", async () => {
    mocks.zora.mockResolvedValue({ data: { zora20Tokens: [{ address: a, chainId: 8453 }, null] } });
    mocks.fetch.mockImplementation(async () => Response.json({ data: [token(b)] }));
    expect(await getSwapTokenSources([a, b])).toEqual({
      tokens: [
        { address: a, source: "zora" },
        { address: b, source: "clanker" },
      ],
      complete: true,
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[0][0]).toContain(`q=${b}`);
  });
  it("preserves known Zora tokens, retries transient Clanker failures, and caches successful negatives", async () => {
    mocks.zora.mockResolvedValue({ data: { zora20Tokens: [{ address: a, chainId: 8453 }] } });
    mocks.fetch
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockImplementation(async () => Response.json({ data: [] }));
    expect(await getSwapTokenSources([a, b])).toEqual({
      tokens: [{ address: a, source: "zora" }],
      complete: false,
    });
    expect((await getSwapTokenSources([a, b])).complete).toBe(true);
    expect((await getSwapTokenSources([a, b])).complete).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.zora).toHaveBeenCalledTimes(1);
  });
  it("bounds Clanker concurrency to four for a cold batch", async () => {
    let active = 0;
    let peak = 0;
    mocks.fetch.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return Response.json({ data: [] });
    });
    const result = await getSwapTokenSources(
      Array.from({ length: 25 }, (_, index) => address(index + 1)),
    );
    expect(result.complete).toBe(true);
    expect(peak).toBe(4);
    expect(mocks.fetch).toHaveBeenCalledTimes(25);
  });
  it("marks unprocessed addresses partial when cold lookups exhaust the time budget", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    mocks.fetch.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 4000);
      return Response.json({ data: [] });
    });
    expect(
      (await getSwapTokenSources(Array.from({ length: 25 }, (_, index) => address(index + 1))))
        .complete,
    ).toBe(false);
    expect(mocks.fetch.mock.calls.length).toBeLessThan(25);
  });
  it("does not negative-cache malformed successful responses", async () => {
    mocks.fetch
      .mockImplementationOnce(async () => Response.json({ error: "not a token response" }))
      .mockImplementation(async () => Response.json({ data: [token(a)] }));
    expect((await getSwapTokenSources([a])).complete).toBe(false);
    expect(await getSwapTokenSources([a])).toEqual({
      tokens: [{ address: a, source: "clanker" }],
      complete: true,
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
});
