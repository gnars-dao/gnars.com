import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { describe, expect, it, vi } from "vitest";
import { calculateVaultEarnings, loadVaultHistory, type VaultLog } from "./vault-accounting";

const account = "0x1111111111111111111111111111111111111111" as Address;
const other = "0x2222222222222222222222222222222222222222" as Address;
const abi = parseAbi([
  "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
  "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

function transfer(index: number, from: Address, to: Address, value: bigint): VaultLog {
  return {
    block_number: 1,
    index,
    topics: [
      ...(encodeEventTopics({ abi, eventName: "Transfer", args: { from, to } }) as Hex[]),
      null,
    ],
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  };
}

function deposit(index: number, assets: bigint, shares: bigint): VaultLog[] {
  return [
    transfer(index, zeroAddress, account, shares),
    {
      block_number: 1,
      index: index + 1,
      topics: encodeEventTopics({
        abi,
        eventName: "Deposit",
        args: { sender: account, owner: account },
      }) as Hex[],
      data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [assets, shares]),
    },
  ];
}

function withdraw(index: number, assets: bigint, shares: bigint): VaultLog[] {
  return [
    transfer(index, account, zeroAddress, shares),
    {
      block_number: 1,
      index: index + 1,
      topics: encodeEventTopics({
        abi,
        eventName: "Withdraw",
        args: { sender: account, receiver: account, owner: account },
      }) as Hex[],
      data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [assets, shares]),
    },
  ];
}

const earnings = (logs: VaultLog[], shares: bigint, assets: bigint) =>
  calculateVaultEarnings({ logs, shares, assets, account, blockNumber: 1n });

describe("protected vault principal", () => {
  it("reports only growth above deposits", () => {
    expect(earnings(deposit(0, 100n, 1100n), 1100n, 110n)).toEqual({
      principal: 100n,
      earned: 10n,
    });
  });

  it("does not offer a second harvest without new yield", () => {
    const logs = [...deposit(0, 100n, 1100n), ...withdraw(2, 10n, 100n)];
    expect(earnings(logs, 1000n, 100n)).toEqual({ principal: 100n, earned: 0n });
    expect(earnings(logs, 1000n, 102n).earned).toBe(2n);
  });

  it("conservatively suppresses yield after an external partial capital withdrawal", () => {
    const logs = [...deposit(0, 100n, 1000n), ...withdraw(2, 50n, 500n)];
    expect(earnings(logs, 500n, 55n)).toEqual({ principal: 100n, earned: 0n });
  });

  it("resets the capital floor after a complete exit and subsequent deposit", () => {
    const logs = [
      ...deposit(0, 100n, 1000n),
      ...withdraw(2, 110n, 1000n),
      ...deposit(4, 20n, 200n),
    ];
    expect(earnings(logs.reverse(), 200n, 22n)).toEqual({ principal: 20n, earned: 2n });
  });

  it("refuses missing or partially indexed deposits and burns", () => {
    expect(() => earnings([], 1000n, 110n)).toThrow("does not reconcile");
    expect(() => earnings(deposit(0, 10n, 100n), 1100n, 111n)).toThrow("does not reconcile");
    expect(() => earnings([deposit(0, 100n, 1000n)[1]], 1000n, 110n)).toThrow("does not reconcile");
  });

  it("refuses transferred shares with unknown basis even when balances match", () => {
    const logs = [
      ...deposit(0, 100n, 1000n),
      transfer(2, account, other, 10n),
      transfer(3, other, account, 10n),
    ];
    expect(() => earnings(logs, 1000n, 110n)).toThrow("unknown principal");
  });

  it("ignores zero and self transfers", () => {
    const logs = [
      ...deposit(0, 100n, 1000n),
      transfer(2, other, account, 0n),
      transfer(3, account, account, 10n),
    ];
    expect(earnings(logs, 1000n, 110n).earned).toBe(10n);
  });

  it("rejects fee-share mints without a known deposit basis", () => {
    expect(() =>
      earnings([...deposit(0, 100n, 1000n), transfer(2, zeroAddress, account, 10n)], 1010n, 111n),
    ).toThrow("does not reconcile");
  });

  it("rejects undecodable accounting events and duplicate events", () => {
    const logs = deposit(0, 100n, 1000n);
    expect(() => earnings([logs[0], { ...logs[1], data: "0x" }], 1000n, 110n)).toThrow("decode");
    expect(() => earnings([...logs, logs[0]], 1000n, 110n)).toThrow("duplicate");
  });

  it("uses the same block as the position read", () => {
    const logs = [
      ...deposit(0, 100n, 1000n),
      ...deposit(2, 50n, 500n).map((log) => ({ ...log, block_number: 2 })),
    ];
    expect(earnings(logs, 1000n, 110n).earned).toBe(10n);
  });
});

describe("vault history pagination", () => {
  it("follows cursors until the explicit final page", async () => {
    const logs = deposit(0, 100n, 1000n);
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: [logs[1]],
        next_page_params: { block_number: 1, index: 1, items_count: 50 },
      })
      .mockResolvedValueOnce({ items: [logs[0]], next_page_params: null });
    expect(await loadVaultHistory(account, fetchPage)).toEqual([logs[1], logs[0]]);
    expect(fetchPage.mock.calls[1][0]).toContain("?block_number=1&index=1&items_count=50");
  });

  it("fails closed on an unavailable later page", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [], next_page_params: { index: 1 } })
      .mockResolvedValueOnce(null);
    await expect(loadVaultHistory(account, fetchPage)).rejects.toThrow("unavailable");
  });

  it("rejects malformed pages and repeated cursors", async () => {
    await expect(
      loadVaultHistory(account, vi.fn().mockResolvedValue({ items: [] })),
    ).rejects.toThrow("unavailable");
    await expect(
      loadVaultHistory(
        account,
        vi.fn().mockResolvedValue({ items: [], next_page_params: { index: 1 } }),
      ),
    ).rejects.toThrow("repeated");
  });
});
