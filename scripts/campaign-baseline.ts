/**
 * Campaign baseline collector — "Stake or Die" (Gnars x Morpheus).
 *
 * WHY THIS EXISTS
 * ---------------
 * The campaign ships 2026-08-26. Everything it moves (MOR staked to the Gnars
 * Builder subnet, how many distinct people staked, what the treasury holds) is
 * a *level*, not a log: the chain tells you the balance NOW, and a level read
 * after the fact cannot tell you what the campaign changed. There is no
 * retroactive read for "how many stakers before the announcement". Either the
 * number is captured before the campaign goes out, or the campaign can only
 * ever be judged by anecdote.
 *
 * So this script freezes the "before" and — just as important — IS the method.
 * The re-collection on 27/08, 28/08 and 01/09 is the same command, so the two
 * measurements are comparable by construction instead of by memory.
 *
 *   pnpm campaign:baseline              # collect a snapshot
 *   pnpm campaign:baseline --compare    # diff the two most recent snapshots
 *
 * Snapshots land in scripts/data/campaign-baseline/<utc-iso>.json and are
 * committed. See scripts/README-campaign-baseline.md for the full procedure,
 * including the one metric this script deliberately does NOT collect (traffic).
 *
 * EVERY on-chain read is pinned to a single block number, recorded in the
 * output. Two metrics read a few seconds apart are not a snapshot; a pinned
 * block makes the whole set internally consistent and independently re-checkable
 * by anyone with an RPC and the block number.
 */

import fs from "fs";
import path from "path";
import {
  createPublicClient,
  decodeEventLog,
  erc20Abi,
  fallback,
  formatEther,
  formatUnits,
  getAddress,
  http,
  parseAbiItem,
  toEventSelector,
  type Address,
} from "viem";
import { base } from "viem/chains";
import { DAO_ADDRESSES, TREASURY_TOKEN_ALLOWLIST } from "@/lib/config";
import {
  BASE_RPCS,
  BUILDERS,
  buildersAbi,
  GNARS_SUBNET_ID,
  MOR_BASE,
  MOR_DECIMALS,
} from "@/lib/morpheus-builder";

const OUT_DIR = path.join(process.cwd(), "scripts/data/campaign-baseline");

/**
 * Block the Gnars subnet was created in (tx 0x998742b3…, `createSubnet`).
 * Nothing about this subnet exists before it, so the log scan starts here
 * instead of at genesis.
 */
const SUBNET_GENESIS_BLOCK = 49285903n;

/**
 * Base's public RPCs cap `eth_getLogs` at a 10k block range (Alchemy's free
 * tier caps it at TEN), so the history is read in chunks.
 *
 * It is read from an RPC on purpose. The first version of this script used
 * Blockscout's Etherscan-compatible endpoint, which answers the whole range in
 * one keyless request — and which SILENTLY OMITTED a log: a real 2 MOR deposit
 * from 0xC1afA4c0…F3E218 in block 50066903 is absent from its index but present
 * in `eth_getLogs` for that exact block. That one missing log undercounted
 * distinct stakers by 5 -> 6, a 20% error in the headline campaign metric, and
 * it produced no error of any kind. An indexer is a convenience; the chain is
 * the record. The reconciliation check below is what caught it, which is why it
 * runs on every collection and not just the first.
 */
const LOG_CHUNK = 9_000n;

/**
 * The proxy at BUILDERS resolves to BuildersV4. Only two of its 19 events touch
 * staker positions; the rest (AdminClaimed, SubnetCreated, SubnetEdited…) are
 * subnet housekeeping and are counted but not decoded.
 */
const USER_DEPOSITED = parseAbiItem(
  "event UserDeposited(bytes32 indexed subnetId, address indexed user, uint256 amount)",
);
const USER_WITHDRAWN = parseAbiItem(
  "event UserWithdrawn(bytes32 indexed subnetId, address indexed user, uint256 amount)",
);
const USER_DEPOSITED_TOPIC = toEventSelector(USER_DEPOSITED);
const USER_WITHDRAWN_TOPIC = toEventSelector(USER_WITHDRAWN);

type RawLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
};

type StakerPosition = {
  address: Address;
  stakedMor: number;
  /**
   * Unix seconds of this address's most recent deposit, read from
   * `usersData.lastDeposit` on chain — not from the log, which carries no
   * timestamp over `eth_getLogs`. Drives the 7-day withdraw lock.
   */
  lastDepositAt: number;
  depositCount: number;
  withdrawCount: number;
};

const client = createPublicClient({
  chain: base,
  transport: fallback(BASE_RPCS.map((u) => http(u))),
});

async function fetchSubnetLogs(toBlock: bigint): Promise<RawLog[]> {
  const out: RawLog[] = [];
  for (let from = SUBNET_GENESIS_BLOCK; from <= toBlock; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n > toBlock ? toBlock : from + LOG_CHUNK - 1n;
    const chunk = (await client.request({
      method: "eth_getLogs",
      params: [
        {
          address: BUILDERS,
          topics: [null, GNARS_SUBNET_ID],
          fromBlock: `0x${from.toString(16)}`,
          toBlock: `0x${to.toString(16)}`,
        },
      ],
    } as never)) as RawLog[];
    out.push(...chunk);
  }
  return out;
}

/**
 * Distinct stakers, from the deposit log plus a current on-chain read per
 * address.
 *
 * The two halves answer different questions and both are needed. The log says
 * who ever staked; `usersData` says who is still staked right now. Deriving the
 * live position by summing deposits minus withdrawals would drift the moment a
 * partial withdrawal or a contract upgrade changed the arithmetic, so the
 * position always comes from the contract and the log is used only to enumerate
 * candidates.
 */
async function collectStakers(logs: RawLog[], blockNumber: bigint) {
  const deposits = new Map<Address, number>();
  const withdrawals = new Map<Address, number>();
  let otherEvents = 0;

  for (const log of logs) {
    const topics = log.topics.filter(Boolean) as [`0x${string}`, ...`0x${string}`[]];
    for (const abi of [USER_DEPOSITED, USER_WITHDRAWN]) {
      try {
        const decoded = decodeEventLog({
          abi: [abi],
          data: log.data as `0x${string}`,
          topics,
        });
        const user = getAddress((decoded.args as { user: Address }).user);
        if (decoded.eventName === "UserDeposited") {
          deposits.set(user, (deposits.get(user) ?? 0) + 1);
        } else {
          withdrawals.set(user, (withdrawals.get(user) ?? 0) + 1);
        }
      } catch {
        /* not this event — try the next, then fall through to otherEvents */
      }
    }
    if (topics[0] !== USER_DEPOSITED_TOPIC && topics[0] !== USER_WITHDRAWN_TOPIC) otherEvents++;
  }

  const candidates = [...new Set([...deposits.keys(), ...withdrawals.keys()])];
  const positions = await client.multicall({
    contracts: candidates.map((user) => ({
      address: BUILDERS,
      abi: buildersAbi,
      functionName: "usersData" as const,
      args: [user, GNARS_SUBNET_ID] as const,
    })),
    blockNumber,
    allowFailure: false,
  });

  const stakers: StakerPosition[] = candidates.map((address, i) => {
    const [lastDeposit, , deposited] = positions[i] as readonly bigint[];
    return {
      address,
      stakedMor: Number(formatUnits(deposited, MOR_DECIMALS)),
      lastDepositAt: Number(lastDeposit),
      depositCount: deposits.get(address) ?? 0,
      withdrawCount: withdrawals.get(address) ?? 0,
    };
  });

  stakers.sort((a, b) => b.stakedMor - a.stakedMor);
  return { stakers, otherEvents };
}

async function collectSubnet(blockNumber: bigint) {
  const [subnetsData, currentRewards, morHeldByContract] = await Promise.all([
    client.readContract({
      address: BUILDERS,
      abi: buildersAbi,
      functionName: "subnetsData",
      args: [GNARS_SUBNET_ID],
      blockNumber,
    }) as Promise<readonly bigint[]>,
    client.readContract({
      address: BUILDERS,
      abi: buildersAbi,
      functionName: "getCurrentSubnetRewards",
      args: [GNARS_SUBNET_ID],
      blockNumber,
    }) as Promise<bigint>,
    client.readContract({
      address: MOR_BASE,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [BUILDERS],
      blockNumber,
    }),
  ]);

  return {
    subnetId: GNARS_SUBNET_ID,
    buildersContract: BUILDERS,
    depositedMor: Number(formatUnits(subnetsData[1], MOR_DECIMALS)),
    depositedMorWei: subnetsData[1].toString(),
    rate: subnetsData[3].toString(),
    pendingRewardsMor: Number(formatUnits(subnetsData[4], MOR_DECIMALS)),
    currentSubnetRewardsMor: Number(formatUnits(currentRewards, MOR_DECIMALS)),
    /** Every subnet on this contract shares the pool, so this is a sanity ceiling, not the Gnars figure. */
    contractMorBalance: Number(formatUnits(morHeldByContract, MOR_DECIMALS)),
  };
}

/**
 * Treasury as RAW balances, deliberately un-priced.
 *
 * A USD figure moves with the market, so "treasury went up" after the campaign
 * would be unreadable — was that the campaign or was that ETH? Raw balances
 * change only when the treasury actually receives or spends, which is the thing
 * the campaign claims to affect. Price it at read time if you want colour; the
 * comparable series is the raw one.
 */
async function collectTreasury(blockNumber: bigint) {
  const treasury = getAddress(DAO_ADDRESSES.treasury);
  const tokens = Object.entries(TREASURY_TOKEN_ALLOWLIST) as Array<[string, Address]>;

  const [ethWei, balances, decimals] = await Promise.all([
    client.getBalance({ address: treasury, blockNumber }),
    client.multicall({
      contracts: tokens.map(([, address]) => ({
        address: getAddress(address),
        abi: erc20Abi,
        functionName: "balanceOf" as const,
        args: [treasury] as const,
      })),
      blockNumber,
      allowFailure: false,
    }),
    client.multicall({
      contracts: tokens.map(([, address]) => ({
        address: getAddress(address),
        abi: erc20Abi,
        functionName: "decimals" as const,
      })),
      blockNumber,
      allowFailure: false,
    }),
  ]);

  return {
    address: treasury,
    chain: "base",
    eth: Number(formatEther(ethWei)),
    ethWei: ethWei.toString(),
    tokens: Object.fromEntries(
      tokens.map(([symbol], i) => [
        symbol,
        {
          amount: Number(formatUnits(balances[i], decimals[i])),
          raw: balances[i].toString(),
          decimals: decimals[i],
        },
      ]),
    ),
  };
}

/**
 * The rider sponsorship graph (MOR referred through each rider's vault) comes
 * from the site's own /api/stake-graph rather than being recomputed here: it is
 * the exact number the campaign pages show, so a divergence between this file
 * and the page would be a bug in one of them, not two views of the truth.
 */
async function collectSponsorshipGraph() {
  const res = await fetch("https://www.gnars.com/api/stake-graph", {
    headers: { "User-Agent": "gnars-campaign-baseline" },
  });
  if (!res.ok)
    return { error: `HTTP ${res.status}`, source: "https://www.gnars.com/api/stake-graph" };
  const d = (await res.json()) as {
    total: number;
    backerCount: number;
    backersResolved: boolean;
    gnarsAccrued: number;
    athletes: Array<{ handle: string; total: number; vaultTvl: number; backers?: unknown[] }>;
  };
  return {
    source: "https://www.gnars.com/api/stake-graph",
    totalReferredMor: d.total,
    backerCount: d.backerCount,
    backersResolved: d.backersResolved,
    gnarsAccruedMor: d.gnarsAccrued,
    athletes: d.athletes.map((a) => ({
      handle: a.handle,
      total: a.total,
      vaultTvl: a.vaultTvl,
      backers: a.backers?.length ?? 0,
    })),
  };
}

/**
 * Traffic is NOT collected here, on purpose.
 *
 * gnars.com runs GA4 (property G-S0R9RBJDKL, verified firing on /stake,
 * /morpheus, /base and their pt-br routes). GA retains aggregate reports, so
 * unlike every on-chain level above, page traffic CAN be pulled retroactively —
 * it is the one campaign metric that does not expire. Pulling it needs
 * credentials this repo does not hold (a GA4 Data API service account, or a
 * human in the GA UI), so the script records the exact report to run instead of
 * silently omitting the metric.
 */
const TRAFFIC_SPEC = {
  collected: false,
  reason:
    "GA4 needs credentials this repo does not hold. Retroactive pull is possible — GA retains aggregate reports — so this metric does not expire with the campaign.",
  property: "G-S0R9RBJDKL",
  verifiedFiringOn: ["/stake", "/morpheus", "/base", "/pt-br/stake"],
  reportToRun: {
    dimensions: ["date", "pagePath"],
    metrics: ["screenPageViews", "totalUsers", "sessions", "averageSessionDuration"],
    pagePathFilter: [
      "/stake",
      "/morpheus",
      "/base",
      "/pt-br/stake",
      "/pt-br/morpheus",
      "/pt-br/base",
    ],
    dateRange:
      "2026-08-12..2026-08-25 for the pre-campaign baseline; extend the end date on each re-collection",
  },
} as const;

async function collect() {
  const block = await client.getBlock();
  const blockNumber = block.number;
  const capturedAt = new Date(Number(block.timestamp) * 1000).toISOString();

  console.log(`Pinning Base block ${blockNumber} (${capturedAt})`);

  const logs = await fetchSubnetLogs(blockNumber);
  const [subnet, { stakers, otherEvents }, treasury, sponsorship] = await Promise.all([
    collectSubnet(blockNumber),
    collectStakers(logs, blockNumber),
    collectTreasury(blockNumber),
    collectSponsorshipGraph(),
  ]);

  const active = stakers.filter((s) => s.stakedMor > 0);
  const stakedSum = active.reduce((acc, s) => acc + s.stakedMor, 0);
  const largest = active[0]?.stakedMor ?? 0;

  const snapshot = {
    campaign: "stake-or-die",
    capturedAt,
    chain: { name: "base", chainId: base.id, blockNumber: blockNumber.toString() },
    subnet,
    stakers: {
      /** Addresses holding a live position at the pinned block. */
      activeCount: active.length,
      /** Addresses that ever deposited, including any who fully withdrew. */
      everCount: stakers.length,
      totalStakedMor: stakedSum,
      /**
       * Concentration is the difference between "40 people staked" and "one
       * whale doubled". A total that moves without this moving is one wallet.
       */
      largestPositionMor: largest,
      largestPositionShare: stakedSum > 0 ? largest / stakedSum : 0,
      medianPositionMor: active.length ? active[Math.floor(active.length / 2)].stakedMor : 0,
      depositEvents: stakers.reduce((a, s) => a + s.depositCount, 0),
      withdrawEvents: stakers.reduce((a, s) => a + s.withdrawCount, 0),
      otherSubnetEvents: otherEvents,
      positions: active,
    },
    /**
     * The contract's own subnet total vs. the sum of the positions we found.
     * If these diverge, the staker enumeration missed someone — which would
     * silently understate "how many people staked", the exact number the
     * campaign is being judged on. Checked on every run, not just this one.
     */
    reconciliation: {
      subnetDepositedMor: subnet.depositedMor,
      sumOfPositionsMor: stakedSum,
      deltaMor: subnet.depositedMor - stakedSum,
      ok: Math.abs(subnet.depositedMor - stakedSum) < 1e-9,
    },
    treasury,
    sponsorshipGraph: sponsorship,
    traffic: TRAFFIC_SPEC,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${capturedAt.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2) + "\n");

  console.log(`\n  MOR staked in subnet   ${subnet.depositedMor.toFixed(6)}`);
  console.log(`  active stakers         ${active.length} (${stakers.length} ever deposited)`);
  console.log(
    `  largest position       ${largest.toFixed(2)} MOR (${(snapshot.stakers.largestPositionShare * 100).toFixed(1)}% of staked)`,
  );
  console.log(
    `  deposits / withdrawals ${snapshot.stakers.depositEvents} / ${snapshot.stakers.withdrawEvents}`,
  );
  console.log(
    `  reconciliation         ${snapshot.reconciliation.ok ? "OK" : `MISMATCH ${snapshot.reconciliation.deltaMor}`}`,
  );
  console.log(
    `  treasury               ${treasury.eth.toFixed(4)} ETH + ${Object.entries(treasury.tokens)
      .map(([s, t]) => `${t.amount} ${s}`)
      .join(", ")}`,
  );
  console.log(
    `  referred via riders    ${"totalReferredMor" in sponsorship ? sponsorship.totalReferredMor : sponsorship.error} MOR`,
  );
  console.log(
    `  traffic                not collected (GA4 ${TRAFFIC_SPEC.property}, pull retroactively)`,
  );
  console.log(`\nWrote ${path.relative(process.cwd(), file)}`);

  if (!snapshot.reconciliation.ok) {
    console.error(
      "\nWARNING: positions do not sum to the subnet total — the staker list is incomplete. Do not publish the staker count from this snapshot until it reconciles.",
    );
    process.exitCode = 1;
  }
}

function listSnapshots(): string[] {
  if (!fs.existsSync(OUT_DIR)) return [];
  return fs
    .readdirSync(OUT_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => path.join(OUT_DIR, f));
}

function compare() {
  const files = listSnapshots();
  if (files.length < 2) {
    console.error(
      `Need two snapshots to compare; found ${files.length} in ${path.relative(process.cwd(), OUT_DIR)}.`,
    );
    process.exitCode = 1;
    return;
  }
  const [beforeFile, afterFile] = files.slice(-2);
  const before = JSON.parse(fs.readFileSync(beforeFile, "utf8"));
  const after = JSON.parse(fs.readFileSync(afterFile, "utf8"));

  const row = (label: string, a: number, b: number, unit = "") => {
    const delta = b - a;
    const pct = a !== 0 ? ` (${delta >= 0 ? "+" : ""}${((delta / a) * 100).toFixed(1)}%)` : "";
    console.log(
      `  ${label.padEnd(24)} ${String(a).padStart(14)} -> ${String(b).padStart(14)}  ${delta >= 0 ? "+" : ""}${delta.toFixed(6)}${unit}${pct}`,
    );
  };

  console.log(`${path.basename(beforeFile)}  ->  ${path.basename(afterFile)}\n`);
  row("MOR staked", before.subnet.depositedMor, after.subnet.depositedMor);
  row("active stakers", before.stakers.activeCount, after.stakers.activeCount);
  row("largest position MOR", before.stakers.largestPositionMor, after.stakers.largestPositionMor);
  row("largest share", before.stakers.largestPositionShare, after.stakers.largestPositionShare);
  row("deposit events", before.stakers.depositEvents, after.stakers.depositEvents);
  row("treasury ETH", before.treasury.eth, after.treasury.eth);
  for (const symbol of Object.keys(after.treasury.tokens)) {
    row(
      `treasury ${symbol}`,
      before.treasury.tokens[symbol]?.amount ?? 0,
      after.treasury.tokens[symbol].amount,
    );
  }
  if (
    "totalReferredMor" in after.sponsorshipGraph &&
    "totalReferredMor" in before.sponsorshipGraph
  ) {
    row(
      "referred via riders",
      before.sponsorshipGraph.totalReferredMor,
      after.sponsorshipGraph.totalReferredMor,
    );
    row("rider backers", before.sponsorshipGraph.backerCount, after.sponsorshipGraph.backerCount);
  }

  // The headline number can rise for two very different reasons, and the
  // campaign is only vindicated by one of them.
  const newStakers = after.stakers.activeCount - before.stakers.activeCount;
  const morDelta = after.subnet.depositedMor - before.subnet.depositedMor;
  console.log("");
  if (morDelta > 0 && newStakers <= 0) {
    console.log(
      "  READ: MOR grew with no new stakers — existing positions got bigger, not more people.",
    );
  } else if (morDelta > 0 && newStakers > 0) {
    console.log(
      `  READ: ${newStakers} new staker(s) and +${morDelta.toFixed(2)} MOR — the campaign brought people, not just size.`,
    );
  } else if (morDelta < 0) {
    console.log("  READ: MOR fell — check withdrawEvents before blaming the campaign.");
  } else {
    console.log("  READ: no movement.");
  }
  console.log(
    `  Traffic is not in these files — pull GA4 ${after.traffic.property} for the same date range.`,
  );
}

const main = process.argv.includes("--compare") ? compare : collect;
void (async () => {
  try {
    await main();
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
