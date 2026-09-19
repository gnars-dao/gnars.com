import {
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  zeroAddress,
  zeroHash,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";
import {
  parseNativeHistoryLog,
  type NativeHistoryBlock,
  type NativeHistoryLog,
} from "./native-history";
import { sweepAbi } from "./sweep";

const protocol = "0x1111111111111111111111111111111111111111";
const seller = "0x2222222222222222222222222222222222222222";
const buyer = "0x3333333333333333333333333333333333333333";
const nft = "0x4444444444444444444444444444444444444444";
const fee = "0x5555555555555555555555555555555555555555";
const erc20 = "0x6666666666666666666666666666666666666666";
const hash = (n: string) => `0x${n.repeat(64)}` as Hex;
const block: NativeHistoryBlock = {
  chainId: 8453,
  protocolAddress: protocol,
  blockNumber: 100n,
  blockHash: hash("a"),
  timestamp: 1_800_000_000n,
};
const spent = { itemType: 2, token: nft, identifier: 123n, amount: 1n } as const;
const payment = {
  itemType: 0,
  token: zeroAddress,
  identifier: 0n,
  amount: 990n,
  recipient: seller,
} as const;
const defaults: Args = {
  orderHash: hash("b"),
  offerer: seller,
  zone: zeroAddress,
  recipient: buyer,
  offer: [spent],
  consideration: [payment, { ...payment, amount: 10n, recipient: fee }],
};
type Args = {
  orderHash: Hex;
  offerer: Hex;
  zone: Hex;
  recipient: Hex;
  offer: { itemType: number; token: Hex; identifier: bigint; amount: bigint }[];
  consideration: {
    itemType: number;
    token: Hex;
    identifier: bigint;
    amount: bigint;
    recipient: Hex;
  }[];
};
function log(overrides: Partial<Args> = {}): NativeHistoryLog {
  const args = { ...defaults, ...overrides };
  return {
    address: protocol,
    blockNumber: 100n,
    blockHash: hash("a"),
    transactionHash: hash("c"),
    logIndex: 3,
    removed: false,
    topics: encodeEventTopics({ abi: sweepAbi, eventName: "OrderFulfilled", args }) as Hex[],
    data: encodeAbiParameters(
      getAbiItem({ abi: sweepAbi, name: "OrderFulfilled" }).inputs.filter(
        (input) => !("indexed" in input && input.indexed),
      ),
      [args.orderHash, args.recipient, args.offer, args.consideration],
    ),
  };
}

describe("native history parser", () => {
  it("preserves the decoded event and includes fees in the gross sale", () => {
    const event = parseNativeHistoryLog(log(), block);
    expect(event.sale).toEqual({
      collectionAddress: nft,
      tokenId: "123",
      seller,
      buyer,
      payment: { tokenAddress: zeroAddress, quantity: "1000" },
    });
    expect(event.raw.consideration).toEqual([
      { ...payment, identifier: "0", amount: "990" },
      { ...payment, identifier: "0", amount: "10", recipient: fee },
    ]);
    expect(event).toMatchObject({ blockNumber: "100", timestamp: 1_800_000_000, logIndex: 3 });
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });

  it("identifies each log independently of an order hash", () => {
    const input = log();
    const first = parseNativeHistoryLog(input, block);
    expect(parseNativeHistoryLog(input, block).id).toBe(first.id);
    expect(parseNativeHistoryLog({ ...input, logIndex: 4 }, block).id).not.toBe(first.id);
    expect(
      parseNativeHistoryLog({ ...input, address: fee }, { ...block, protocolAddress: fee }).id,
    ).not.toBe(first.id);
    expect(first.id).toBe(`8453:${protocol}:${hash("c")}:3`);
  });

  it("does not invent ERC20 symbols or decimals", () => {
    const event = parseNativeHistoryLog(
      log({ consideration: [{ ...payment, itemType: 1, token: erc20 }] }),
      block,
    );
    expect(event.sale?.payment).toEqual({ tokenAddress: erc20, quantity: "990" });
  });

  it.each([
    ["bundle", { offer: [spent, { ...spent, identifier: 124n }] }],
    ["ERC1155", { offer: [{ ...spent, itemType: 3 }] }],
    ["criteria item", { offer: [{ ...spent, itemType: 4 }] }],
    ["multiple quantity", { offer: [{ ...spent, amount: 2n }] }],
    ["empty offer", { offer: [] }],
    ["null NFT address", { offer: [{ ...spent, token: zeroAddress }] }],
    ["matched order", { recipient: zeroAddress }],
    ["barter", { consideration: [{ ...payment, itemType: 2, token: nft }] }],
    ["empty consideration", { consideration: [] }],
    ["mixed currencies", { consideration: [payment, { ...payment, itemType: 1, token: erc20 }] }],
    [
      "different ERC20s",
      {
        consideration: [
          { ...payment, itemType: 1, token: erc20 },
          { ...payment, itemType: 1, token: fee },
        ],
      },
    ],
    ["invalid native token", { consideration: [{ ...payment, token: erc20 }] }],
    ["invalid ERC20 token", { consideration: [{ ...payment, itemType: 1 }] }],
    ["currency identifier", { consideration: [{ ...payment, identifier: 1n }] }],
    ["zero recipient", { consideration: [{ ...payment, recipient: zeroAddress }] }],
    ["zero price", { consideration: [{ ...payment, amount: 0n }] }],
    ["price overflow", { consideration: [{ ...payment, amount: 2n ** 256n - 1n }, payment] }],
  ] satisfies [string, Partial<Args>][])("retains %s without a fabricated sale", (_, overrides) => {
    const event = parseNativeHistoryLog(log(overrides), block);
    expect(event.sale).toBeNull();
    expect(event.raw.orderHash).toBe(defaults.orderHash);
  });

  it.each([
    { removed: true },
    { removed: undefined },
    { address: buyer },
    { address: "bad" },
    { blockNumber: null },
    { blockNumber: 101n },
    { blockHash: hash("d") },
    { blockHash: null },
    { transactionHash: null },
    { transactionHash: zeroHash },
    { transactionHash: "0x123" },
    { logIndex: null },
    { logIndex: -1 },
    { logIndex: 1.5 },
    { logIndex: Number.MAX_SAFE_INTEGER + 1 },
    { topics: [] },
    { topics: [zeroHash, zeroHash, zeroHash] },
    { data: "0x01" },
  ])("rejects unconfirmed or mismatched log metadata %#", (overrides) => {
    expect(() =>
      parseNativeHistoryLog({ ...log(), ...overrides } as NativeHistoryLog, block),
    ).toThrow();
  });

  it.each([
    { chainId: 0 },
    { chainId: 1.5 },
    { protocolAddress: zeroAddress },
    { blockNumber: -1n },
    { blockNumber: 2n ** 256n },
    { blockHash: zeroHash },
    { timestamp: 0 },
    { timestamp: -1 },
    { timestamp: 1.5 },
    { timestamp: 8640000000001n },
  ])("rejects invalid block context %#", (overrides) => {
    expect(() => parseNativeHistoryLog(log(), { ...block, ...overrides })).toThrow();
  });

  it("rejects extra data and extra topics", () => {
    const input = log();
    expect(() => parseNativeHistoryLog({ ...input, data: `${input.data}00` }, block)).toThrow();
    expect(() =>
      parseNativeHistoryLog({ ...input, topics: [...input.topics, zeroHash] }, block),
    ).toThrow();
  });

  it("rejects noncanonical indexed address padding", () => {
    const input = log();
    const topics = [...input.topics];
    topics[1] = `0x01${topics[1].slice(4)}`;
    expect(() => parseNativeHistoryLog({ ...input, topics }, block)).toThrow();
  });

  it.each([
    { orderHash: zeroHash },
    { offerer: zeroAddress },
    { offer: [{ ...spent, itemType: 6 }] },
  ])("rejects invalid Seaport identities/types %#", (args) => {
    expect(() => parseNativeHistoryLog(log(args), block)).toThrow();
  });
});
