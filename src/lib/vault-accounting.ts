import {
  decodeEventLog,
  parseAbi,
  toEventSelector,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { blockscoutGet } from "@/services/blockscout";

const events = parseAbi([
  "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
  "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const accountingTopics = new Set(events.map((event) => toEventSelector(event)));

export interface VaultLog {
  block_number: number;
  index: number;
  data: Hex;
  topics: (Hex | null)[];
}

interface LogPage {
  items: VaultLog[];
  next_page_params: Record<string, string | number> | null;
}

export class VaultHistoryUnavailableError extends Error {
  constructor(message = "Complete vault history is unavailable") {
    super(message);
    this.name = "VaultHistoryUnavailableError";
  }
}

/** Follow every cursor; a truncated or failed history must never become zero principal. */
export async function loadVaultHistory(
  vault: Address,
  getPage: (path: string) => Promise<LogPage | null> = blockscoutGet<LogPage>,
): Promise<VaultLog[]> {
  const logs: VaultLog[] = [];
  const cursors = new Set<string>();
  let query = "";
  for (let page = 0; page < 100; page++) {
    const result = await getPage(`addresses/${vault}/logs${query}`);
    if (!result || !Array.isArray(result.items) || !("next_page_params" in result)) {
      throw new VaultHistoryUnavailableError();
    }
    logs.push(...result.items);
    if (result.next_page_params === null) return logs;
    const next = result.next_page_params;
    if (!next || typeof next !== "object" || Object.keys(next).length === 0) {
      throw new VaultHistoryUnavailableError();
    }
    const cursor = new URLSearchParams();
    for (const [key, value] of Object.entries(next).sort(([a], [b]) => a.localeCompare(b))) {
      if (typeof value !== "string" && typeof value !== "number") {
        throw new VaultHistoryUnavailableError();
      }
      cursor.set(key, String(value));
    }
    query = `?${cursor.toString()}`;
    if (cursors.has(query)) throw new VaultHistoryUnavailableError("Vault history cursor repeated");
    cursors.add(query);
  }
  throw new VaultHistoryUnavailableError("Vault history exceeds the accounting scan limit");
}

/**
 * Protect deposits until a full exit. Partial withdrawals may contain earnings,
 * so they never lower this capital floor. An external partial capital withdrawal
 * can therefore suppress later claims until the floor is recovered or the
 * position fully exits. Share transfers have unknown basis and disable claims.
 */
export function calculateVaultEarnings({
  logs,
  account,
  shares,
  assets,
  blockNumber,
}: {
  logs: VaultLog[];
  account: Address;
  shares: bigint;
  assets: bigint;
  blockNumber: bigint;
}): { principal: bigint; earned: bigint } {
  const me = account.toLowerCase();
  let principal = 0n;
  let positionShares = 0n;
  let transferredShares = 0n;
  const seen = new Set<string>();
  const ordered = [...logs].sort((a, b) => a.block_number - b.block_number || a.index - b.index);
  for (const log of ordered) {
    if (!Number.isSafeInteger(log.block_number) || !Number.isSafeInteger(log.index)) {
      throw new VaultHistoryUnavailableError("Vault history has no reliable event order");
    }
    if (BigInt(log.block_number) > blockNumber) continue;
    const id = `${log.block_number}:${log.index}`;
    if (seen.has(id))
      throw new VaultHistoryUnavailableError("Vault history contains duplicate events");
    seen.add(id);
    if (!Array.isArray(log.topics) || !log.topics[0]) {
      throw new VaultHistoryUnavailableError("Malformed vault event");
    }
    if (!accountingTopics.has(log.topics[0])) continue;
    let event;
    try {
      event = decodeEventLog({
        abi: events,
        data: log.data,
        topics: log.topics.filter((topic): topic is Hex => topic !== null) as [Hex, ...Hex[]],
      });
    } catch {
      throw new VaultHistoryUnavailableError("Unable to decode vault accounting event");
    }
    if (event.eventName === "Transfer") {
      const from = event.args.from.toLowerCase();
      const to = event.args.to.toLowerCase();
      if (event.args.value === 0n || from === to || (from !== me && to !== me)) continue;
      if (from !== zeroAddress && to !== zeroAddress) {
        throw new VaultHistoryUnavailableError("Transferred vault shares have unknown principal");
      }
      transferredShares += to === me ? event.args.value : -event.args.value;
      continue;
    }
    if (event.args.owner.toLowerCase() !== me) continue;
    if (event.eventName === "Deposit") {
      principal += event.args.assets;
      positionShares += event.args.shares;
    } else {
      if (event.args.shares > positionShares) {
        throw new VaultHistoryUnavailableError("Vault withdrawals exceed recorded deposits");
      }
      positionShares -= event.args.shares;
      if (positionShares === 0n) principal = 0n;
    }
  }
  // Reconcile to the same on-chain block: indexing lag, missing events, and
  // unsupported fee-share mints cannot silently inflate an earnings estimate.
  if (
    positionShares !== shares ||
    transferredShares !== shares ||
    (shares > 0n && principal === 0n)
  ) {
    throw new VaultHistoryUnavailableError("Vault history does not reconcile with the position");
  }
  return { principal, earned: assets > principal ? assets - principal : 0n };
}

const positionAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
]);

export type VaultAccountingReader = Pick<PublicClient, "getBlockNumber" | "readContract">;

export async function readVaultEarnings(
  client: VaultAccountingReader,
  vault: Address,
  account: Address,
) {
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const shares = await client.readContract({
    address: vault,
    abi: positionAbi,
    functionName: "balanceOf",
    args: [account],
    blockNumber,
  });
  if (shares === 0n) return { shares, assets: 0n, principal: 0n, earned: 0n };
  const [assets, logs] = await Promise.all([
    client.readContract({
      address: vault,
      abi: positionAbi,
      functionName: "convertToAssets",
      args: [shares],
      blockNumber,
    }),
    loadVaultHistory(vault),
  ]);
  return {
    shares,
    assets,
    ...calculateVaultEarnings({ logs, account, shares, assets, blockNumber }),
  };
}
