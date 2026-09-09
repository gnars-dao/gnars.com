import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cache: vi.fn((fn: unknown) => fn),
  mor: vi.fn(),
  base: vi.fn(),
  holders: vi.fn(),
}));
vi.mock("next/cache", () => ({ unstable_cache: mocks.cache }));
vi.mock("viem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem")>()),
  createPublicClient: () => ({ multicall: mocks.base }),
}));
vi.mock("@/services/morpheus-backing", () => ({ readMorpheusBacking: mocks.mor }));
vi.mock("@/services/blockscout", () => ({ blockscoutGet: mocks.holders }));
vi.mock("@/services/prices", () => ({ getEthUsd: async () => 2000 }));
vi.mock("@/lib/gnars-vaults", () => ({
  RIDER_LIST: [
    {
      id: "will",
      handle: "will",
      wallet: "0x2222222222222222222222222222222222222222",
      vault: "0x1111111111111111111111111111111111111111",
    },
  ],
}));

const backing = {
  byRider: {
    will: [
      {
        address: "0x3333333333333333333333333333333333333333",
        amount: 22,
        tokenAmount: "0.011",
        kind: "mor",
        asset: "steth",
        routing: "unconfigured",
      },
    ],
  },
  mor: 0,
  morUsd: 0,
};

beforeEach(() => {
  vi.resetModules();
  mocks.mor.mockReset();
  mocks.base.mockReset();
  mocks.base.mockResolvedValue([
    { status: "success", result: 0n },
    { status: "success", result: 0n },
  ]);
});

describe("stake graph Morpheus completeness", () => {
  it("uses a new cache key for the changed graph contract", async () => {
    await import("./stake-graph");
    expect(mocks.cache).toHaveBeenLastCalledWith(
      expect.any(Function),
      ["stake-graph-v2"],
      expect.any(Object),
    );
  });

  it("keeps known funded backing in a degraded graph without passing it into the data cache", async () => {
    mocks.mor.mockResolvedValue({ ...backing, resolved: false });
    const { getStakeGraph, loadStakeGraph } = await import("./stake-graph");
    await expect(getStakeGraph()).rejects.toMatchObject({ isStakeGraphDegraded: true });
    const { graph, degraded } = await loadStakeGraph();
    expect(degraded).toBe(true);
    expect(graph).toMatchObject({
      total: 22,
      morResolved: false,
      backersResolved: true,
      gnarsMor: 0,
    });
    expect(graph.athletes[0].backers[0]).toMatchObject({
      routing: "unconfigured",
      tokenAmount: "0.011",
    });
  });

  it("does not hide a new Morpheus outage when returning the last complete graph", async () => {
    mocks.mor.mockResolvedValueOnce({ ...backing, resolved: true });
    mocks.mor.mockResolvedValueOnce({ byRider: {}, mor: 0, morUsd: 0, resolved: false });
    const { loadStakeGraph } = await import("./stake-graph");
    expect((await loadStakeGraph()).degraded).toBe(false);
    const { graph, degraded } = await loadStakeGraph();
    expect(degraded).toBe(true);
    expect(graph.total).toBe(22);
    expect(graph.morResolved).toBe(false);
    expect(graph.backersResolved).toBe(true);
  });

  it("marks genuinely complete empty Morpheus data as resolved", async () => {
    mocks.mor.mockResolvedValue({ byRider: {}, mor: 0, morUsd: 0, resolved: true });
    const { loadStakeGraph } = await import("./stake-graph");
    expect(await loadStakeGraph()).toMatchObject({
      graph: { total: 0, morResolved: true, backersResolved: true },
      degraded: false,
    });
  });
});
