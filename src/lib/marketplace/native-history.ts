import {
  decodeEventLog,
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  isAddress,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { sweepAbi } from "./sweep";

type HistoryItem = {
  itemType: number;
  token: Address;
  identifier: string;
  amount: string;
};
export type NativeHistoryEvent = {
  id: string;
  chainId: number;
  protocolAddress: Address;
  blockNumber: string;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: number;
  timestamp: number;
  raw: {
    orderHash: Hex;
    offerer: Address;
    zone: Address;
    recipient: Address;
    offer: HistoryItem[];
    consideration: (HistoryItem & { recipient: Address })[];
  };
  sale: {
    collectionAddress: Address;
    tokenId: string;
    seller: Address;
    buyer: Address;
    payment: { tokenAddress: Address; quantity: string };
  } | null;
};

export type NativeHistoryLog = {
  address: string;
  topics: readonly Hex[];
  data: Hex;
  blockNumber: bigint | null;
  blockHash: string | null;
  transactionHash: string | null;
  logIndex: number | null;
  removed: boolean;
};
export type NativeHistoryBlock = {
  chainId: number;
  protocolAddress: string;
  blockNumber: bigint;
  blockHash: string;
  timestamp: bigint | number;
};

const eventAbi = getAbiItem({ abi: sweepAbi, name: "OrderFulfilled" });
const hashPattern = /^0x[\da-fA-F]{64}$/;
const uint256Limit = 2n ** 256n;
const lower = <T extends string>(value: T) => value.toLowerCase() as T;
const addressValid = (value: string) => isAddress(value, { strict: false });
const hashValid = (value: string | null): value is Hex =>
  typeof value === "string" && hashPattern.test(value) && lower(value) !== zeroHash;

/** The caller supplies a canonical, finalized block; this pure parser cannot prove finality. */
export function parseNativeHistoryLog(
  log: NativeHistoryLog,
  block: NativeHistoryBlock,
): NativeHistoryEvent {
  const timestamp = Number(block.timestamp);
  if (
    !Number.isSafeInteger(block.chainId) ||
    block.chainId <= 0 ||
    !addressValid(block.protocolAddress) ||
    lower(block.protocolAddress) === zeroAddress ||
    !addressValid(log.address) ||
    lower(log.address) !== lower(block.protocolAddress) ||
    typeof block.blockNumber !== "bigint" ||
    block.blockNumber < 0n ||
    block.blockNumber >= uint256Limit ||
    log.blockNumber !== block.blockNumber ||
    !hashValid(block.blockHash) ||
    !hashValid(log.blockHash) ||
    lower(log.blockHash) !== lower(block.blockHash) ||
    !hashValid(log.transactionHash) ||
    !Number.isSafeInteger(log.logIndex) ||
    log.logIndex === null ||
    log.logIndex < 0 ||
    log.removed !== false ||
    (typeof block.timestamp !== "bigint" && typeof block.timestamp !== "number") ||
    !Number.isSafeInteger(timestamp) ||
    timestamp <= 0 ||
    timestamp > 8640000000000 ||
    log.topics.length !== 3 ||
    log.topics.some((topic) => !hashPattern.test(topic)) ||
    !/^0x(?:[\da-fA-F]{2})*$/.test(log.data)
  ) {
    throw new Error("Invalid native history log metadata");
  }

  const { args } = decodeEventLog({
    abi: sweepAbi,
    eventName: "OrderFulfilled",
    topics: [...log.topics] as [Hex, ...Hex[]],
    data: log.data,
    strict: true,
  });
  // Round-trip rejects extra bytes, noncanonical offsets, and malformed address padding.
  const topics = encodeEventTopics({ abi: sweepAbi, eventName: "OrderFulfilled", args });
  const data = encodeAbiParameters(
    eventAbi.inputs.filter((input) => !("indexed" in input && input.indexed)),
    [args.orderHash, args.recipient, args.offer, args.consideration],
  );
  if (
    lower(data) !== lower(log.data) ||
    topics.some((topic, index) => lower(topic as Hex) !== lower(log.topics[index])) ||
    args.orderHash === zeroHash ||
    lower(args.offerer) === zeroAddress ||
    [...args.offer, ...args.consideration].some((item) => item.itemType > 5)
  ) {
    throw new Error("Invalid native history event encoding");
  }

  const item = (value: (typeof args.offer)[number]): HistoryItem => ({
    itemType: value.itemType,
    token: lower(value.token),
    identifier: value.identifier.toString(),
    amount: value.amount.toString(),
  });
  const raw: NativeHistoryEvent["raw"] = {
    orderHash: lower(args.orderHash),
    offerer: lower(args.offerer),
    zone: lower(args.zone),
    recipient: lower(args.recipient),
    offer: args.offer.map(item),
    consideration: args.consideration.map((value) => ({
      ...item(value),
      recipient: lower(value.recipient),
    })),
  };
  const nft = raw.offer[0];
  const currency = raw.consideration[0];
  let sale: NativeHistoryEvent["sale"] = null;
  // Bundles, barter, offers and matchOrders lack an unambiguous per-NFT sale price/buyer.
  if (
    raw.offer.length === 1 &&
    nft.itemType === 2 &&
    nft.amount === "1" &&
    nft.token !== zeroAddress &&
    raw.recipient !== zeroAddress &&
    currency &&
    (currency.itemType === 0 || currency.itemType === 1) &&
    (currency.itemType === 0 ? currency.token === zeroAddress : currency.token !== zeroAddress) &&
    raw.consideration.every(
      (payment) =>
        payment.itemType === currency.itemType &&
        payment.token === currency.token &&
        payment.identifier === "0" &&
        payment.recipient !== zeroAddress,
    )
  ) {
    const total = raw.consideration.reduce((sum, payment) => sum + BigInt(payment.amount), 0n);
    if (total > 0n && total < uint256Limit) {
      sale = {
        collectionAddress: nft.token,
        tokenId: nft.identifier,
        seller: raw.offerer,
        buyer: raw.recipient,
        payment: { tokenAddress: currency.token, quantity: total.toString() },
      };
    }
  }
  const protocolAddress = lower(block.protocolAddress) as Address;
  const transactionHash = lower(log.transactionHash);
  return {
    id: `${block.chainId}:${protocolAddress}:${transactionHash}:${log.logIndex}`,
    chainId: block.chainId,
    protocolAddress,
    blockNumber: block.blockNumber.toString(),
    blockHash: lower(log.blockHash),
    transactionHash,
    logIndex: log.logIndex,
    timestamp,
    raw,
    sale,
  };
}
