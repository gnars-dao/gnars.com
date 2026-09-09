import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const address = "0x1111111111111111111111111111111111111111";

describe("ENS client cache", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("retries failed forward lookups instead of caching them as missing names", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(Response.json({ address }));
    vi.stubGlobal("fetch", fetch);
    const { resolveAddressFromENS } = await import("./ens");
    expect(await resolveAddressFromENS("gnars.eth")).toBeNull();
    expect(await resolveAddressFromENS("gnars.eth")).toBe(address);
    expect(await resolveAddressFromENS("GNARS.ETH")).toBe(address);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent lookups and caches successful missing-name responses", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ address: null }));
    vi.stubGlobal("fetch", fetch);
    const { resolveAddressFromENS } = await import("./ens");
    expect(
      await Promise.all([
        resolveAddressFromENS("missing.eth"),
        resolveAddressFromENS("missing.eth"),
      ]),
    ).toEqual([null, null]);
    expect(await resolveAddressFromENS("missing.eth")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("splits more than 50 addresses into bounded batches and reuses their cache", async () => {
    const addresses = Array.from(
      { length: 105 },
      (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`,
    );
    const fetch = vi.fn().mockImplementation(async (_url, options) => {
      const { addresses: batch } = JSON.parse(options.body) as { addresses: string[] };
      return Response.json({
        ensMap: Object.fromEntries(
          batch.map((address) => [address, { name: `${address}.eth`, avatar: null }]),
        ),
      });
    });
    vi.stubGlobal("fetch", fetch);
    const { resolveENSBatch, resolveENS } = await import("./ens");
    const onBatch = vi.fn();
    const result = await resolveENSBatch([...addresses, addresses[0]], { onBatch });
    expect(Object.keys(result)).toHaveLength(105);
    expect(
      fetch.mock.calls.map(([, options]) => JSON.parse(options.body).addresses.length),
    ).toEqual([50, 50, 5]);
    expect(onBatch.mock.calls.map(([entries]) => Object.keys(entries).length)).toEqual([50, 50, 5]);
    expect(await resolveENSBatch(addresses)).toEqual(result);
    expect((await resolveENS(addresses[0])).name).toBe(result[addresses[0]].name);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("keeps successful subsets when a batch fails and retries only unresolved addresses", async () => {
    const addresses = Array.from(
      { length: 101 },
      (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`,
    );
    let count = 0;
    const fetch = vi.fn().mockImplementation(async (_url, options) => {
      if (++count === 2) return new Response(null, { status: 502 });
      const { addresses: batch } = JSON.parse(options.body) as { addresses: string[] };
      return Response.json({
        ensMap: Object.fromEntries(
          batch.map((address) => [address, { name: "resolved.eth", avatar: null }]),
        ),
      });
    });
    vi.stubGlobal("fetch", fetch);
    const { resolveENSBatch } = await import("./ens");
    const onBatch = vi.fn();
    expect(Object.keys(await resolveENSBatch(addresses, { onBatch }))).toHaveLength(51);
    expect(onBatch.mock.calls.map(([entries]) => Object.keys(entries).length)).toEqual([50, 1]);
    expect(Object.keys(await resolveENSBatch(addresses))).toHaveLength(101);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(JSON.parse(fetch.mock.calls[3][1].body).addresses).toEqual(addresses.slice(50, 100));
  });

  it.each([429, 503])(
    "stops after status %s without discarding previous results",
    async (status) => {
      const addresses = Array.from(
        { length: 151 },
        (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`,
      );
      const fetch = vi
        .fn()
        .mockImplementationOnce(async (_url, options) => {
          const { addresses: batch } = JSON.parse(options.body) as { addresses: string[] };
          return Response.json({
            ensMap: Object.fromEntries(batch.map((address) => [address, { name: "resolved.eth" }])),
          });
        })
        .mockResolvedValue(new Response(null, { status }));
      vi.stubGlobal("fetch", fetch);
      const { resolveENSBatch } = await import("./ens");
      expect(Object.keys(await resolveENSBatch(addresses))).toHaveLength(50);
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it("aborts the active request and does not launch subsequent batches", async () => {
    const addresses = Array.from(
      { length: 51 },
      (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`,
    );
    const controller = new AbortController();
    const fetch = vi.fn().mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const { resolveENSBatch } = await import("./ens");
    const onBatch = vi.fn();
    const pending = resolveENSBatch(addresses, { signal: controller.signal, onBatch });
    controller.abort();
    expect(await pending).toEqual({});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].signal).toBe(controller.signal);
    expect(onBatch).not.toHaveBeenCalled();
    expect(await resolveENSBatch(addresses, { signal: controller.signal })).toEqual({});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
