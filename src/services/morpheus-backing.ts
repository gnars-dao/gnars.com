import {
  createPublicClient,
  erc20Abi,
  fallback,
  formatUnits,
  getAddress,
  http,
  isAddress,
  type Abi,
  type Address,
} from "viem";
import { arbitrum, mainnet } from "viem/chains";
import { RIDER_LIST } from "@/lib/gnars-vaults";
import { pushSplitFactoryAbi, SPLIT_OWNER, SPLIT_SALT, splitParamsFor } from "@/lib/mor-split";
import {
  ARBITRUM_PUSH_SPLIT_FACTORY,
  depositPoolAbi,
  MOR_DECIMALS,
  MOR_GNARS_RECIPIENT,
  MOR_REWARD_POOL_INDEX,
  MOR_TOKEN,
  MORPHEUS_POOLS,
} from "@/lib/morpheus";
import { discoverMorpheusUsers } from "@/services/morpheus-discovery";
import { getTokenPriceUsd, type UsdPrice } from "@/services/prices";

export type MorpheusRouting = "verified-split" | "unconfigured" | "custom" | "unknown";
export type MorpheusBacker = {
  address: Address;
  amount: number;
  tokenAmount: string;
  kind: "mor";
  asset: "steth" | "usdc";
  routing: MorpheusRouting;
};

const alchemyKey = process.env.ALCHEMY_API_KEY;
const ethClient = createPublicClient({
  chain: mainnet,
  transport: fallback(
    [
      ...(alchemyKey ? [`https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`] : []),
      "https://eth.drpc.org",
      "https://ethereum.publicnode.com",
      "https://eth.llamarpc.com",
    ].map((url) => http(url, { timeout: 5000, retryCount: 0 })),
    { retryCount: 0 },
  ),
});
const arbClient = createPublicClient({
  chain: arbitrum,
  transport: fallback(
    [
      ...(alchemyKey ? [`https://arb-mainnet.g.alchemy.com/v2/${alchemyKey}`] : []),
      "https://arb1.arbitrum.io/rpc",
      "https://arbitrum.publicnode.com",
    ].map((url) => http(url, { timeout: 5000, retryCount: 0 })),
    { retryCount: 0 },
  ),
});

type ReadResult = { status: "success" | "failure"; result?: unknown };
type Contracts = readonly {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}[];

/** Bound both aggregate payload size and the number of active upstream calls. */
async function readBatch(
  client: typeof ethClient | typeof arbClient,
  contracts: Contracts,
  blockNumber?: bigint,
) {
  const results: ReadResult[] = [];
  for (let offset = 0; offset < contracts.length; offset += 60) {
    const batch = contracts.slice(offset, offset + 60);
    try {
      const response = await client.multicall({
        contracts: batch,
        allowFailure: true,
        blockNumber,
      });
      if (response.length !== batch.length) throw new Error("Incomplete multicall");
      results.push(...response);
    } catch {
      results.push(...batch.map(() => ({ status: "failure" as const })));
    }
  }
  return results;
}

function addressResult(read: ReadResult | undefined): Address | null {
  return read?.status === "success" && typeof read.result === "string" && isAddress(read.result)
    ? getAddress(read.result)
    : null;
}

function bigintResult(read: ReadResult | undefined): bigint | null {
  return read?.status === "success" && typeof read.result === "bigint" && read.result >= 0n
    ? read.result
    : null;
}

export function classifyMorpheusRouting(
  receiver: Address | null,
  expected: Address | null,
): MorpheusRouting {
  if (!receiver) return "unknown";
  if (BigInt(receiver) === 0n) return "unconfigured";
  if (!expected) return "unknown";
  return receiver.toLowerCase() === expected.toLowerCase() ? "verified-split" : "custom";
}

type Candidate = {
  id: string;
  referrer: Address;
  user: Address;
  pool: Address;
  asset: "steth" | "usdc";
  decimals: number;
};

export async function readMorpheusBacking(ethUsd: UsdPrice): Promise<{
  byRider: Record<string, MorpheusBacker[]>;
  resolved: boolean;
  mor: number;
  morUsd: number;
}> {
  let resolved = true;
  const byRider: Record<string, MorpheusBacker[]> = {};
  const pairs = Object.entries(MORPHEUS_POOLS).flatMap(([asset, config]) =>
    RIDER_LIST.filter((rider) => rider.wallet).map((rider) => ({
      id: rider.id,
      referrer: rider.wallet!,
      pool: config.pool,
      decimals: config.decimals,
      asset: (asset === "stEth" ? "steth" : "usdc") as "steth" | "usdc",
    })),
  );
  const candidates = new Map<string, Candidate>();
  // Indexer queries cover full history, not an ever-moving recent-block window.
  for (let offset = 0; offset < pairs.length; offset += 4) {
    const wave = pairs.slice(offset, offset + 4);
    const discoveries = await Promise.all(
      wave.map((pair) => discoverMorpheusUsers(pair.pool, pair.referrer)),
    );
    discoveries.forEach((discovery, index) => {
      if (!discovery.resolved) resolved = false;
      for (const user of discovery.users) {
        const pair = wave[index];
        const key = `${pair.pool}-${user}`.toLowerCase();
        if (candidates.has(key)) continue;
        if (candidates.size >= 300) {
          resolved = false;
          continue;
        }
        candidates.set(key, { ...pair, user });
      }
    });
  }

  const rows = [...candidates.values()];
  const blockNumber = rows.length ? await ethClient.getBlockNumber().catch(() => null) : null;
  const reads: ReadResult[] =
    blockNumber === null
      ? rows.flatMap(() => [
          { status: "failure" as const },
          { status: "failure" as const },
          { status: "failure" as const },
        ])
      : await readBatch(
          ethClient,
          rows.flatMap(({ pool, user }) => [
            {
              address: pool,
              abi: depositPoolAbi,
              functionName: "usersData",
              args: [user, MOR_REWARD_POOL_INDEX],
            },
            {
              address: pool,
              abi: depositPoolAbi,
              functionName: "claimReceiver",
              args: [MOR_REWARD_POOL_INDEX, user],
            },
            {
              address: pool,
              abi: depositPoolAbi,
              functionName: "getLatestUserReward",
              args: [MOR_REWARD_POOL_INDEX, user],
            },
          ]),
          blockNumber,
        );
  const current: Array<
    Candidate & { deposited: bigint; receiver: Address | null; reward: bigint | null }
  > = [];
  rows.forEach((candidate, index) => {
    const userData = reads[index * 3];
    const values = userData?.result;
    if (
      userData?.status !== "success" ||
      !Array.isArray(values) ||
      typeof values[1] !== "bigint" ||
      values[1] < 0n ||
      typeof values[8] !== "string" ||
      !isAddress(values[8])
    ) {
      resolved = false;
      return;
    }
    // A historical event is not proof of the position's current referrer.
    const rider = pairs.find((pair) => pair.referrer.toLowerCase() === values[8].toLowerCase());
    if (!rider) return;
    const receiver = addressResult(reads[index * 3 + 1]);
    if (!receiver) resolved = false;
    current.push({
      ...candidate,
      id: rider.id,
      referrer: rider.referrer,
      deposited: values[1],
      receiver,
      reward: bigintResult(reads[index * 3 + 2]),
    });
  });

  const splitPairs = new Map<string, { user: Address; referrer: Address }>();
  const splitKey = (position: { user: Address; referrer: Address }) =>
    `${position.user}-${position.referrer}`.toLowerCase();
  current.forEach((position) => splitPairs.set(splitKey(position), position));
  const unique = [...splitPairs.values()];
  const predictions = await readBatch(
    arbClient,
    unique.map(({ user, referrer }) => ({
      address: ARBITRUM_PUSH_SPLIT_FACTORY,
      abi: pushSplitFactoryAbi,
      functionName: "predictDeterministicAddress",
      args: [splitParamsFor(user, referrer), SPLIT_OWNER, SPLIT_SALT],
    })),
  );
  const splits = new Map<string, Address>();
  unique.forEach((pair, index) => {
    const split = addressResult(predictions[index]);
    if (split) splits.set(splitKey(pair), split);
    else resolved = false;
  });

  let pendingGnars = 0n;
  for (const position of current) {
    const routing = classifyMorpheusRouting(
      position.receiver,
      splits.get(splitKey(position)) ?? null,
    );
    if (routing === "verified-split") {
      if (position.reward === null) resolved = false;
      else pendingGnars += position.reward / 4n;
    }
    if (position.deposited === 0n) continue;
    const tokenAmount = formatUnits(position.deposited, position.decimals);
    if (position.asset === "steth" && ethUsd === null) {
      throw new Error("stake-graph: ETH/USD unavailable for funded stETH position");
    }
    const amount = Number(tokenAmount) * (position.asset === "steth" ? ethUsd! : 1);
    (byRider[position.id] ??= []).push({
      address: position.user,
      amount,
      tokenAmount,
      kind: "mor",
      asset: position.asset,
      routing,
    });
  }

  const splitAddresses = [...new Set(splits.values())];
  const balances = await readBatch(
    arbClient,
    [MOR_GNARS_RECIPIENT, ...splitAddresses].map((address) => ({
      address: MOR_TOKEN,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    })),
  );
  let earned = pendingGnars;
  balances.forEach((result, index) => {
    const balance = bigintResult(result);
    if (balance === null) resolved = false;
    else earned += index === 0 ? balance : balance / 4n;
  });
  const mor = Number(formatUnits(earned, MOR_DECIMALS));
  const price = mor > 0 ? await getTokenPriceUsd(MOR_TOKEN, "arbitrum-one") : 0;
  if (mor > 0 && price === null) throw new Error("stake-graph: MOR/USD unavailable");
  return { byRider, resolved, mor, morUsd: mor * (price ?? 0) };
}
