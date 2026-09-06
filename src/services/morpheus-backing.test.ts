import { zeroAddress } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MOR_GNARS_RECIPIENT, MORPHEUS_POOLS } from "@/lib/morpheus";
import { classifyMorpheusRouting, readMorpheusBacking } from "./morpheus-backing";

const mocks = vi.hoisted(() => ({
  eth: vi.fn(),
  block: vi.fn(),
  arb: vi.fn(),
  discovery: vi.fn(),
  price: vi.fn(),
}));
vi.mock("viem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem")>()),
  createPublicClient: ({ chain }: { chain: { id: number } }) => ({
    multicall: chain.id === 1 ? mocks.eth : mocks.arb,
    getBlockNumber: mocks.block,
  }),
}));
vi.mock("@/lib/gnars-vaults", () => ({
  RIDER_LIST: [{ id: "will", wallet: "0x2222222222222222222222222222222222222222" }],
}));
vi.mock("@/services/morpheus-discovery", () => ({ discoverMorpheusUsers: mocks.discovery }));
vi.mock("@/services/prices", () => ({ getTokenPriceUsd: mocks.price }));

const user = "0x3333333333333333333333333333333333333333";
const referrer = "0x2222222222222222222222222222222222222222";
const split = "0x4444444444444444444444444444444444444444";
const custom = "0x5555555555555555555555555555555555555555";
const success = (result: unknown) => ({ status: "success", result });
type Call = { functionName: string; args: unknown[] };
let principal: bigint;
let receiver: string | null;
let storedReferrer: string;

beforeEach(() => {
  vi.clearAllMocks();
  principal = 11_000_000_000_000_000n;
  mocks.block.mockResolvedValue(25_000_000n);
  receiver = zeroAddress;
  storedReferrer = referrer;
  mocks.price.mockResolvedValue(2);
  mocks.discovery.mockImplementation(async (pool) => ({
    users: pool === MORPHEUS_POOLS.stEth.pool ? [user, user] : [],
    resolved: true,
  }));
  mocks.eth.mockImplementation(async ({ contracts }: { contracts: Call[] }) =>
    contracts.map(({ functionName }) => {
      if (functionName === "usersData") {
        return success([0n, principal, 0n, 0n, 0n, 0n, 0n, 0n, storedReferrer]);
      }
      if (functionName === "claimReceiver") {
        return receiver ? success(receiver) : { status: "failure" };
      }
      return success(8_000_000_000_000_000_000n);
    }),
  );
  mocks.arb.mockImplementation(async ({ contracts }: { contracts: Call[] }) =>
    contracts.map(({ functionName }) =>
      success(functionName === "predictDeterministicAddress" ? split : 0n),
    ),
  );
});

describe("current Morpheus backing", () => {
  it("counts funded unconfigured routing using current principal, once per user", async () => {
    const graph = await readMorpheusBacking(2000);
    expect(graph.resolved).toBe(true);
    expect(graph.byRider.will).toEqual([
      {
        address: user,
        amount: 22,
        tokenAmount: "0.011",
        kind: "mor",
        asset: "steth",
        routing: "unconfigured",
      },
    ]);
    expect(graph.mor).toBe(0);
    expect(mocks.eth.mock.calls[0][0].contracts).toHaveLength(3);
    expect(mocks.eth.mock.calls[0][0].blockNumber).toBe(25_000_000n);
  });

  it("drops fully withdrawn positions instead of summing historic deposit events", async () => {
    principal = 0n;
    const graph = await readMorpheusBacking(2000);
    expect(graph.byRider).toEqual({});
    expect(graph.resolved).toBe(true);
  });

  it("does not attribute a position whose current stored referrer is not a rider", async () => {
    storedReferrer = custom;
    expect((await readMorpheusBacking(2000)).byRider).toEqual({});
  });

  it("retains funded principal with unknown routing when its receiver read fails", async () => {
    receiver = null;
    const graph = await readMorpheusBacking(2000);
    expect(graph.resolved).toBe(false);
    expect(graph.byRider.will[0]).toMatchObject({ amount: 22, routing: "unknown" });
    expect(graph.mor).toBe(0);
  });

  it("does not claim custom receiver rewards as Gnars accrual", async () => {
    receiver = custom;
    const graph = await readMorpheusBacking(2000);
    expect(graph.byRider.will[0].routing).toBe("custom");
    expect(graph.mor).toBe(0);
  });

  it("counts only the exact verified split's share of unclaimed rewards", async () => {
    receiver = split;
    const graph = await readMorpheusBacking(2000);
    expect(graph.byRider.will[0].routing).toBe("verified-split");
    expect(graph.mor).toBe(2);
    expect(graph.morUsd).toBe(4);
  });

  it("counts physically held split and treasury balances independently of current routing", async () => {
    mocks.arb.mockImplementation(async ({ contracts }: { contracts: Call[] }) =>
      contracts.map(({ functionName, args }) =>
        success(
          functionName === "predictDeterministicAddress"
            ? split
            : args[0] === MOR_GNARS_RECIPIENT
              ? 1_000_000_000_000_000_000n
              : 4_000_000_000_000_000_000n,
        ),
      ),
    );
    expect((await readMorpheusBacking(2000)).mor).toBe(2);
  });

  it("never reports a failed position multicall as complete empty backing", async () => {
    mocks.eth.mockRejectedValue(new Error("RPC unavailable"));
    const graph = await readMorpheusBacking(2000);
    expect(graph.resolved).toBe(false);
    expect(graph.byRider).toEqual({});
  });

  it("does not read unpinned positions when the mainnet snapshot cannot be captured", async () => {
    mocks.block.mockRejectedValue(new Error("No block available"));
    const graph = await readMorpheusBacking(2000);
    expect(graph.resolved).toBe(false);
    expect(graph.byRider).toEqual({});
    expect(mocks.eth).not.toHaveBeenCalled();
  });

  it("preserves partial discoveries but marks the graph incomplete", async () => {
    mocks.discovery.mockResolvedValue({ users: [user], resolved: false });
    const graph = await readMorpheusBacking(2000);
    expect(graph.resolved).toBe(false);
    expect(graph.byRider.will.length).toBe(2);
  });

  it("marks reward/factory failure incomplete instead of assuming routing is valid", async () => {
    receiver = split;
    mocks.arb.mockRejectedValue(new Error("Arbitrum unavailable"));
    const graph = await readMorpheusBacking(2000);
    expect(graph.resolved).toBe(false);
    expect(graph.byRider.will[0].routing).toBe("unknown");
    expect(graph.mor).toBe(0);
  });

  it("marks a failed verified-split reward read incomplete without dropping principal", async () => {
    receiver = split;
    mocks.eth.mockResolvedValue([
      success([0n, principal, 0n, 0n, 0n, 0n, 0n, 0n, referrer]),
      success(split),
      { status: "failure" },
    ]);
    const graph = await readMorpheusBacking(2000);
    expect(graph.resolved).toBe(false);
    expect(graph.byRider.will[0]).toMatchObject({ amount: 22, routing: "verified-split" });
    expect(graph.mor).toBe(0);
  });

  it("bounds candidate work and pins every mainnet batch to the same snapshot", async () => {
    const users = Array.from(
      { length: 301 },
      (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`,
    );
    mocks.discovery.mockImplementation(async (pool) => ({
      users: pool === MORPHEUS_POOLS.stEth.pool ? users : [],
      resolved: true,
    }));
    const graph = await readMorpheusBacking(2000);
    expect(graph.resolved).toBe(false);
    expect(graph.byRider.will).toHaveLength(300);
    expect(mocks.eth).toHaveBeenCalledTimes(15);
    for (const [request] of mocks.eth.mock.calls) {
      expect(request.contracts.length).toBeLessThanOrEqual(60);
      expect(request.blockNumber).toBe(25_000_000n);
    }
  });

  it("refuses a fabricated zero price for funded stETH", async () => {
    await expect(readMorpheusBacking(null)).rejects.toThrow("ETH/USD unavailable");
  });

  it("distinguishes unset, custom, verified and unknown routing", () => {
    expect(classifyMorpheusRouting(null, split)).toBe("unknown");
    expect(classifyMorpheusRouting(zeroAddress, null)).toBe("unconfigured");
    expect(classifyMorpheusRouting(custom, null)).toBe("unknown");
    expect(classifyMorpheusRouting(custom, split)).toBe("custom");
    expect(classifyMorpheusRouting(split, split)).toBe("verified-split");
  });
});
