import { encodeAbiParameters, encodeEventTopics, getAbiItem, zeroAddress, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { NativeHistoryLog } from "./native-history";
import { scanNativeHistoryRange } from "./native-history-scan";
import { sweepAbi } from "./sweep";

const hash = `0x${"a".repeat(64)}`;
const other = `0x${"b".repeat(64)}`;
const initial = {
  version: 1,
  chainId: 8453,
  protocolAddress: `0x${"1".repeat(40)}`,
  startBlock: "100",
  indexedThrough: null,
  blockHash: null,
};
function setup(target = 200n) {
  return {
    finalized: vi.fn(async () => ({ number: target, hash, timestamp: 1000n })),
    block: vi.fn(async (number: bigint) => ({ number, hash, timestamp: 1000n })),
    logs: vi.fn(async (): Promise<NativeHistoryLog[]> => []),
  };
}

function saleLog(overrides: Partial<NativeHistoryLog> = {}): NativeHistoryLog {
  const seller = `0x${"2".repeat(40)}` as Hex;
  const args = {
    orderHash: `0x${"c".repeat(64)}` as Hex,
    offerer: seller,
    zone: zeroAddress,
    recipient: `0x${"3".repeat(40)}` as Hex,
    offer: [{ itemType: 2, token: `0x${"4".repeat(40)}` as Hex, identifier: 1n, amount: 1n }],
    consideration: [
      { itemType: 0, token: zeroAddress, identifier: 0n, amount: 990n, recipient: seller },
      {
        itemType: 0,
        token: zeroAddress,
        identifier: 0n,
        amount: 10n,
        recipient: `0x${"5".repeat(40)}` as Hex,
      },
    ],
  };
  return {
    address: initial.protocolAddress,
    blockNumber: 105n,
    blockHash: hash,
    transactionHash: `0x${"d".repeat(64)}`,
    logIndex: 4,
    removed: false,
    topics: encodeEventTopics({ abi: sweepAbi, eventName: "OrderFulfilled", args }) as Hex[],
    data: encodeAbiParameters(
      getAbiItem({ abi: sweepAbi, name: "OrderFulfilled" }).inputs.filter(
        (input) => !("indexed" in input && input.indexed),
      ),
      [args.orderHash, args.recipient, args.offer, args.consideration],
    ),
    ...overrides,
  };
}

describe("native history contiguous scan", () => {
  it("indexes canonical sales with gross fees and caches event block reads", async () => {
    const io = setup();
    const first = saleLog();
    const second = saleLog({ logIndex: 5 });
    const before = structuredClone([first, second, initial]);
    io.logs.mockResolvedValue([first, second]);
    const result = await scanNativeHistoryRange(initial, io, 20);
    expect(result.events).toHaveLength(2);
    expect(result.events[0].sale?.payment.quantity).toBe("1000");
    expect(result.events[0].timestamp).toBe(1000);
    expect(result.events[0].id).not.toBe(result.events[1].id);
    expect(io.block.mock.calls).toEqual([[119n], [105n], [119n]]);
    expect([first, second, initial]).toEqual(before);
    expect(result.checkpoint.indexedThrough).toBe("119");
  });

  it.each([
    { blockNumber: 99n },
    { blockNumber: 120n },
    { blockNumber: null },
    { blockHash: other },
    { address: zeroAddress },
    { removed: true },
  ])("rejects invalid event data without advancing checkpoint %#", async (overrides) => {
    const io = setup();
    const input = structuredClone(initial);
    io.logs.mockResolvedValue([saleLog(overrides)]);
    await expect(scanNativeHistoryRange(input, io, 20)).rejects.toThrow();
    expect(input).toEqual(initial);
  });

  it("rejects duplicate log positions even when transaction hashes differ", async () => {
    const io = setup();
    io.logs.mockResolvedValue([saleLog(), saleLog({ transactionHash: other })]);
    await expect(scanNativeHistoryRange(initial, io, 20)).rejects.toThrow(
      "Duplicate history log position",
    );
    expect(initial.indexedThrough).toBeNull();
  });

  it("does not return valid earlier events if a later log fails validation", async () => {
    const io = setup();
    io.logs.mockResolvedValue([saleLog(), saleLog({ logIndex: 5, removed: true })]);
    await expect(scanNativeHistoryRange(initial, io, 20)).rejects.toThrow();
    expect(initial.indexedThrough).toBeNull();
  });

  it("anchors and advances an empty range without claiming complete history", async () => {
    const io = setup();
    const result = await scanNativeHistoryRange(initial, io, 20);
    expect(io.logs).toHaveBeenCalledWith(100n, 119n);
    expect(result).toEqual({
      checkpoint: { ...initial, indexedThrough: "119", blockHash: hash },
      events: [],
      finalizedTarget: "200",
      caughtUp: false,
    });
    expect(initial.indexedThrough).toBeNull();
    expect(io.block.mock.calls).toEqual([[119n], [119n]]);
  });

  it("resumes at the next block and stops exactly at finalized", async () => {
    const io = setup(125n);
    const result = await scanNativeHistoryRange(
      { ...initial, indexedThrough: "119", blockHash: hash },
      io,
      20,
    );
    expect(io.logs).toHaveBeenCalledWith(120n, 125n);
    expect(result.checkpoint.indexedThrough).toBe("125");
    expect(result.caughtUp).toBe(true);
  });

  it("validates an already caught-up checkpoint without querying logs", async () => {
    const io = setup(119n);
    const result = await scanNativeHistoryRange(
      { ...initial, indexedThrough: "119", blockHash: hash },
      io,
    );
    expect(result.caughtUp).toBe(true);
    expect(io.logs).not.toHaveBeenCalled();
    expect(io.block).toHaveBeenCalledWith(119n);
  });

  it("rejects a checkpoint ahead of finality", async () => {
    const io = setup(119n);
    await expect(
      scanNativeHistoryRange({ ...initial, indexedThrough: "120", blockHash: hash }, io),
    ).rejects.toThrow("canonical and finalized");
    expect(io.logs).not.toHaveBeenCalled();
  });

  it("rejects a stale checkpoint before querying logs", async () => {
    const io = setup();
    await expect(
      scanNativeHistoryRange({ ...initial, indexedThrough: "119", blockHash: other }, io),
    ).rejects.toThrow("canonical and finalized");
    expect(io.logs).not.toHaveBeenCalled();
  });

  it("rejects reorg during an empty range", async () => {
    const io = setup();
    io.block
      .mockResolvedValueOnce({ number: 119n, hash, timestamp: 1000n })
      .mockResolvedValueOnce({ number: 119n, hash: other, timestamp: 1000n });
    await expect(scanNativeHistoryRange(initial, io, 20)).rejects.toThrow("changed during scan");
  });

  it("rejects changed finalized target", async () => {
    const io = setup(119n);
    io.block.mockResolvedValue({ number: 119n, hash: other, timestamp: 1000n });
    await expect(scanNativeHistoryRange(initial, io, 20)).rejects.toThrow("target changed");
  });

  it("propagates provider errors and leaves input unchanged", async () => {
    const io = setup();
    io.logs.mockRejectedValue(new Error("provider limit"));
    await expect(scanNativeHistoryRange(initial, io)).rejects.toThrow("provider limit");
    expect(initial.indexedThrough).toBeNull();
  });

  it.each([0, -1, 1.5, 10001, NaN])("rejects invalid range %s", async (range) => {
    await expect(scanNativeHistoryRange(initial, setup(), range)).rejects.toThrow(
      "Invalid history scan range",
    );
  });

  it.each([
    { indexedThrough: "99", blockHash: hash },
    { indexedThrough: "100", blockHash: null },
    { indexedThrough: null, blockHash: hash },
    { chainId: 1 },
    { protocolAddress: `0x${"0".repeat(40)}` },
    { indexedThrough: "100", blockHash: `0x${"0".repeat(64)}` },
    { startBlock: "-1" },
  ])("rejects malformed checkpoint %j", async (overrides) => {
    await expect(scanNativeHistoryRange({ ...initial, ...overrides }, setup())).rejects.toThrow();
  });

  it("rejects RPC returning the wrong block number", async () => {
    const io = setup();
    io.block.mockResolvedValue({ number: 1n, hash, timestamp: 1000n });
    await expect(scanNativeHistoryRange(initial, io)).rejects.toThrow("Invalid history block");
  });
});
