import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMarketplaceCombinedActivity } from "./marketplace-combined-activity";

const mocks = vi.hoisted(() => ({ os: vi.fn(), native: vi.fn() }));
vi.mock("./marketplace-native-activity", () => ({ getNativeMarketplaceActivity: mocks.native }));
vi.mock("./marketplace-activity", async (original) => ({
  ...(await original<typeof import("./marketplace-activity")>()),
  getMarketplaceActivity: mocks.os,
}));
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
const collection = "0x880fb3cf5c6cc2d7dfc13a993e839a9411200c17";
const input = { collection, tokenId: "3646" };
const coverage = { startBlock: "100", indexedThrough: "200", blockHash: `0x${"a".repeat(64)}` };
const event = (id: string, timestamp: number) => ({
  id,
  timestamp,
  transactionHash: `0x${"b".repeat(64)}`,
  type: "sale" as const,
  from: collection,
  to: collection,
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.os.mockResolvedValue({ events: [], nextCursor: null });
  mocks.native.mockResolvedValue({ events: [], nextCursor: null, coverage });
});

describe("combined NFT history", () => {
  it("returns both sources sorted without truncating either page", async () => {
    mocks.os.mockResolvedValue({ events: [event("os", 100)], nextCursor: null });
    mocks.native.mockResolvedValue({
      events: [{ ...event("native", 200), source: "gnars-contract" }],
      nextCursor: null,
      coverage,
    });
    expect(await getMarketplaceCombinedActivity(input)).toMatchObject({
      source: "combined",
      nextCursor: null,
      coverage,
      sources: { opensea: { available: true }, gnars: { available: true } },
      events: [
        { id: "native", source: "gnars-contract" },
        { id: "os", source: "opensea" },
      ],
    });
  });
  it("does not fetch an exhausted native stream again", async () => {
    mocks.os.mockResolvedValueOnce({ events: [], nextCursor: "os-next" });
    const first = await getMarketplaceCombinedActivity(input);
    await getMarketplaceCombinedActivity({ ...input, cursor: first.nextCursor });
    expect(mocks.native).toHaveBeenCalledTimes(1);
    expect(mocks.os).toHaveBeenLastCalledWith({ ...input, cursor: "os-next" });
  });

  it("can resume a bounded cursor containing a large provider cursor", async () => {
    const providerCursor = "a".repeat(4000);
    mocks.os.mockResolvedValueOnce({ events: [], nextCursor: providerCursor });
    const first = await getMarketplaceCombinedActivity(input);
    expect(first.nextCursor!.length).toBeGreaterThan(4096);
    await getMarketplaceCombinedActivity({ ...input, cursor: first.nextCursor });
    expect(mocks.os).toHaveBeenLastCalledWith({ ...input, cursor: providerCursor });
  });
  it("continues native pages after OpenSea exhaustion and pins coverage", async () => {
    const after = { blockNumber: "180", logIndex: 3 };
    mocks.native.mockResolvedValueOnce({
      events: Array.from({ length: 20 }, (_, i) => ({
        ...event(`native-${i}`, 200 - i),
        source: "gnars-contract",
        blockNumber: String(199 - i),
        logIndex: 3,
      })),
      nextCursor: after,
      coverage,
    });
    const first = await getMarketplaceCombinedActivity(input);
    const next = await getMarketplaceCombinedActivity({ ...input, cursor: first.nextCursor });
    expect(mocks.os).toHaveBeenCalledTimes(1);
    expect(mocks.native).toHaveBeenLastCalledWith(collection, "3646", after, "200");
    expect(next.nextCursor).toBeNull();
    expect(next.coverage).toEqual(coverage);
  });

  it("does not emit old native sales before a newer second OpenSea page", async () => {
    const recent = Array.from({ length: 20 }, (_, i) => event(`os-${i}`, 200 - i));
    const oldNative = {
      ...event("native", 100),
      source: "gnars-contract",
      blockNumber: "120",
      logIndex: 1,
    };
    mocks.os
      .mockResolvedValueOnce({ events: recent, nextCursor: "os-page2" })
      .mockResolvedValueOnce({ events: [event("os-21", 150)], nextCursor: null });
    mocks.native.mockResolvedValue({ events: [oldNative], nextCursor: null, coverage });
    const first = await getMarketplaceCombinedActivity(input);
    expect(first.events.map((e) => e.id)).toEqual(recent.map((e) => e.id));
    const second = await getMarketplaceCombinedActivity({ ...input, cursor: first.nextCursor });
    expect(second.events.map((e) => e.id)).toEqual(["os-21", "native"]);
    expect(second.nextCursor).toBeNull();
  });

  it("resumes an unconsumed OpenSea page without skipping older rows", async () => {
    const osEvents = Array.from({ length: 20 }, (_, i) => event(`os-${i}`, 200 - i));
    mocks.os.mockResolvedValue({ events: osEvents, nextCursor: null });
    mocks.native.mockResolvedValueOnce({
      events: [
        { ...event("native", 195), source: "gnars-contract", blockNumber: "150", logIndex: 1 },
      ],
      nextCursor: null,
      coverage,
    });
    const first = await getMarketplaceCombinedActivity(input);
    expect(first.events).toHaveLength(20);
    const second = await getMarketplaceCombinedActivity({ ...input, cursor: first.nextCursor });
    expect(second.events.map((e) => e.id)).toEqual(["os-19"]);
    expect(mocks.native).toHaveBeenCalledTimes(1);
    expect(new Set([...first.events, ...second.events].map((e) => e.id)).size).toBe(21);
  });

  it("fails closed if a partially consumed provider page changes", async () => {
    const osEvents = Array.from({ length: 20 }, (_, i) => event(`os-${i}`, 200 - i));
    mocks.os.mockResolvedValueOnce({ events: osEvents, nextCursor: null }).mockResolvedValueOnce({
      events: [event("new", 300), ...osEvents.slice(0, 19)],
      nextCursor: null,
    });
    mocks.native.mockResolvedValueOnce({
      events: [
        { ...event("native", 195), source: "gnars-contract", blockNumber: "150", logIndex: 1 },
      ],
      nextCursor: null,
      coverage,
    });
    const first = await getMarketplaceCombinedActivity(input);
    await expect(
      getMarketplaceCombinedActivity({ ...input, cursor: first.nextCursor }),
    ).rejects.toMatchObject({ status: 409, code: "ACTIVITY_CURSOR_EXPIRED" });
  });
  it("retains a failed native cursor and OpenSea results for retry", async () => {
    mocks.native.mockRejectedValueOnce(new Error("db offline"));
    mocks.os.mockResolvedValueOnce({ events: [event("os", 100)], nextCursor: null });
    const first = await getMarketplaceCombinedActivity(input);
    expect(first.sources.gnars.available).toBe(false);
    expect(first.events).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const next = await getMarketplaceCombinedActivity({ ...input, cursor: first.nextCursor });
    expect(mocks.os).toHaveBeenCalledTimes(1);
    expect(mocks.native).toHaveBeenLastCalledWith(collection, "3646", undefined, undefined);
    expect(next.nextCursor).toBeNull();
  });
  it("retains failed OpenSea progress without replaying native records", async () => {
    mocks.os.mockRejectedValueOnce(new Error("rate limited"));
    const first = await getMarketplaceCombinedActivity(input);
    expect(first.sources.opensea.available).toBe(false);
    await getMarketplaceCombinedActivity({ ...input, cursor: first.nextCursor });
    expect(mocks.native).toHaveBeenCalledTimes(1);
    expect(mocks.os).toHaveBeenCalledTimes(2);
  });
  it("fails rather than reporting empty history when both providers fail", async () => {
    mocks.os.mockRejectedValue(new Error("offline"));
    mocks.native.mockRejectedValue(new Error("offline"));
    await expect(getMarketplaceCombinedActivity(input)).rejects.toMatchObject({ status: 503 });
  });
  it("binds cursor to the NFT identity", async () => {
    mocks.os.mockResolvedValue({ events: [], nextCursor: "os-next" });
    const first = await getMarketplaceCombinedActivity(input);
    await expect(
      getMarketplaceCombinedActivity({ ...input, tokenId: "1", cursor: first.nextCursor }),
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.os).toHaveBeenCalledTimes(1);
  });
  it.each(["bad", Buffer.from(JSON.stringify({ version: 1 })).toString("base64url")])(
    "rejects malformed cursor %s",
    async (cursor) => {
      await expect(getMarketplaceCombinedActivity({ ...input, cursor })).rejects.toMatchObject({
        status: 400,
      });
      expect(mocks.native).not.toHaveBeenCalled();
    },
  );
});
