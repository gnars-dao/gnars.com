// The whole sponsorship graph — every rider vault's total and who backs it —
// computed SERVER-SIDE and cached, so the orbit loads instantly (shared across
// users) instead of doing dozens of client RPC round-trips on every mount.
//
// Smart tricks vs. the old client hook:
//  - Multicall3: all of a vault's reads (totalAssets/totalSupply/every balance)
//    go in ONE aggregated call instead of 2 round-trips per backer.
//  - Shares → assets is computed locally from totalAssets/totalSupply, killing
//    the per-backer convertToAssets calls entirely.
//  - MOR history discovers candidates; multicalls verify current balances and routing.
//  - The whole result goes through `unstable_cache` under the `stake` tag
//    (caching-standard.md Rule 2): the TTL is a backstop, freshness comes from
//    `revalidateTag("stake")` fired by the deposit/withdraw/claim hooks. That
//    keeps this — the single heaviest server-side operation in the repo — off
//    the request path, so a cache miss at the CDN layer costs a data-cache read
//    instead of the full ~3.5s recompute.
//
//    Scope matters: `unstable_cache` writes to Next's data cache, which is what
//    `revalidateTag` invalidates. It is NOT the CDN — a response already cached
//    by the `Cache-Control` header on /api/stake-graph is not tag-aware and
//    ages out on its own. See that route for how the two windows are split.

import { unstable_cache } from "next/cache";
import { createPublicClient, fallback, formatUnits, getAddress, http, type Address } from "viem";
import { base } from "viem/chains";
import { CACHE_TAGS } from "@/lib/cache-tags";
import { RIDER_LIST, type RiderId } from "@/lib/gnars-vaults";
import { blockscoutGet } from "@/services/blockscout";
import { readMorpheusBacking, type MorpheusRouting } from "@/services/morpheus-backing";
import { getEthUsd } from "@/services/prices";

// Optional Alchemy key is used for Base vault reads and holder discovery only.
const ALCHEMY = process.env.ALCHEMY_API_KEY;
const baseRpcs = [
  ...(ALCHEMY ? [`https://base-mainnet.g.alchemy.com/v2/${ALCHEMY}`] : []),
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://base.drpc.org",
];

const baseClient = createPublicClient({
  chain: base,
  batch: { multicall: true },
  transport: fallback(baseRpcs.map((u) => http(u))),
});
const vaultAbi = [
  {
    type: "function",
    name: "totalAssets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export type OrbitBacker = {
  address: Address;
  amount: number;
  /** "vault" = Morpho USDC sponsorship vault (Base); "mor" = Morpheus stake (mainnet). */
  kind: "vault" | "mor";
  asset?: "steth" | "usdc";
  /** Current funded token units, independent of USD pricing. */
  tokenAmount?: string;
  /** Only verified-split positions accrue unclaimed MOR to Gnars. */
  routing?: MorpheusRouting;
  /**
   * A label the graph already knows, used INSTEAD of the client-side /api/ens
   * lookup. Nothing in this module ever sets it — the live path still resolves
   * names in the browser. It exists for fixture graphs, whose invented
   * addresses resolve to nothing: without it a dense fan renders
   * as a dozen indistinguishable 0x-shorts, and the lookup is a wasted request.
   */
  ens?: string;
};
export type OrbitAthlete = {
  id: RiderId;
  handle: string;
  vault: Address;
  split?: Address;
  /**
   * Morpho sponsorship vault TVL (`totalAssets()`, USDC≈USD). This is the
   * balance the performance fee accrues on, so it — not `total` — is what a
   * yield figure must be read against.
   */
  vaultTvl: number;
  /** Morpheus stake behind this rider, in USD. Earns MOR, not the vault fee. */
  morUsd: number;
  /**
   * Everything backing this rider = `vaultTvl` + `morUsd`.
   *
   * It has to be the sum, because this is the number the orbit node prints and
   * `StakeGraph.total` is the headline above it. While `total` meant "vault
   * only", a rider backed purely through Morpheus rendered UNLIT with no figure
   * at all — Will had $31 of MOR behind him and an empty node — and the
   * per-node values could not be added up to the headline, since only the
   * headline knew about MOR. Zooming into that same rider then listed the
   * backers the overview had just denied.
   */
  total: number;
  feeAccrued: number;
  backers: OrbitBacker[];
};
export type StakeGraph = {
  athletes: OrbitAthlete[];
  total: number;
  backerCount: number;
  /**
   * Whether every rider's VAULT (Morpho) backer list is known to be complete.
   *
   * The distinction this encodes did not exist before: an orbit with no backers
   * meant either "nobody has staked" or "the indexer we ask about holders was
   * down", and the code could not tell you which. Anything rendering backers
   * must check this before drawing a conclusion from an empty list — and must
   * not present a partial list as the full picture.
   *
   * Covers vaults only; Morpheus has its own completeness flag below.
   */
  backersResolved: boolean;
  /** Full Morpheus discovery, current positions, routing and reward reads succeeded. */
  morResolved: boolean;
  /** Gnars' share of the Morpho vault performance fee accrued so far, in USD. */
  gnarsAccrued: number;
  /** Known MOR at the treasury/in splits plus verified routing's unclaimed 25% share. */
  gnarsMor: number;
  /** That MOR valued in USD. */
  gnarsMorUsd: number;
  /** Total earned for the treasury in USD = vault fee + MOR value. */
  treasuryUsd: number;
};

/**
 * Carries the partial graph out of `unstable_cache` on the degraded path — see
 * `loadStakeGraph`. The marker field is what gets checked, not `instanceof`,
 * which does not survive every module/bundle boundary.
 */
class StakeGraphDegradedError extends Error {
  readonly degradedGraph: StakeGraph;
  readonly isStakeGraphDegraded = true as const;
  constructor(graph: StakeGraph) {
    super("stake-graph: backer discovery incomplete");
    this.name = "StakeGraphDegradedError";
    this.degradedGraph = graph;
  }
}

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * WHO HOLDS A VAULT'S SHARES — and what to do when nobody will tell us.
 *
 * There is no "list the holders" call on an ERC-20, so holders can only be
 * recovered from transfer history, which means an indexer. Blockscout was the
 * only one, and it is not reliable enough to be alone: fanning the seven vaults
 * out in parallel (what production does) returned HTTP 500 for 2 of 15 calls
 * from a single laptop, and its `/holders` endpoint reports zero for a vault
 * that on-chain has five holders covering 100% of supply.
 *
 * Two things changed here. There is a second source, and — the part that
 * actually matters — **a failure is now reported instead of flattened into an
 * empty list**. "Nobody backs this rider" and "we could not find out who backs
 * this rider" are different facts about the world, and the `catch {}` that used
 * to live here turned the second into the first, silently, for a whole cache
 * TTL. The orbit then rendered a rider with real deposits as having no backers.
 *
 * Why NOT raw `eth_getLogs` on our own RPC as the second source, which is the
 * obvious idea: measured, every Base endpoint in `baseRpcs` caps the range at
 * 10,000 blocks (mainnet.base.org and drpc say so in the error; Alchemy's free
 * tier allows TEN, and publicnode wants a paid token for archive range at all).
 * The vaults' history is already ~1.08M blocks wide — ~109 chunked calls per
 * vault per cache miss, growing with the chain forever. Alchemy's transfer
 * index answers the same question in one paged call, on the key this module
 * already holds, so it is the same "infra we control" without the fan-out.
 */
type Discovery = Address[] | null;

/** Add a hex address to the set, skipping the zero address and anything malformed. */
function collect(out: Set<Address>, raw: string | null | undefined): void {
  if (!raw || raw.toLowerCase() === ZERO) return;
  try {
    out.add(getAddress(raw));
  } catch {
    /* not an address */
  }
}

/** `null` = the source failed. An empty array = the source answered "none". */
async function fromBlockscout(vault: Address): Promise<Discovery> {
  // Crash-safe helper: a 500 with a non-JSON body now degrades to `null`
  // instead of calling `.json()` on the text body.
  const json = await blockscoutGet<{
    items?: { to?: { hash?: string }; from?: { hash?: string } }[];
  }>(`tokens/${vault}/transfers`);
  // A 200 whose body isn't the shape we expect is a failure, not "no holders".
  if (!json || !Array.isArray(json.items)) return null;
  const out = new Set<Address>();
  for (const t of json.items) {
    collect(out, t.to?.hash);
    collect(out, t.from?.hash);
  }
  return [...out];
}

/**
 * Alchemy's transfer index, paged to the end. Blockscout's `/transfers` serves
 * one page of recent history, so it can answer with a genuine-looking subset of
 * holders once a vault outlives its first page — this one walks `pageKey` to
 * the end instead. The 10-page stop is a runaway guard, not an expected bound.
 */
async function fromAlchemy(vault: Address): Promise<Discovery> {
  if (!ALCHEMY) return null;
  const out = new Set<Address>();
  let pageKey: string | undefined;
  try {
    for (let page = 0; page < 10; page++) {
      const res = await fetch(`https://base-mainnet.g.alchemy.com/v2/${ALCHEMY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "alchemy_getAssetTransfers",
          params: [
            {
              fromBlock: "0x0",
              toBlock: "latest",
              contractAddresses: [vault],
              category: ["erc20"],
              maxCount: "0x3e8",
              ...(pageKey ? { pageKey } : {}),
            },
          ],
        }),
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) return null;
      const j = (await res.json()) as {
        error?: unknown;
        result?: { transfers?: { from?: string; to?: string }[]; pageKey?: string };
      };
      if (j.error || !Array.isArray(j.result?.transfers)) return null;
      for (const t of j.result.transfers) {
        collect(out, t.from);
        collect(out, t.to);
      }
      pageKey = j.result.pageKey;
      if (!pageKey) break;
    }
    return [...out];
  } catch {
    return null;
  }
}

/** Tried in order. Blockscout stays first so a healthy day behaves exactly as before. */
const HOLDER_SOURCES: Array<(vault: Address) => Promise<Discovery>> = [fromBlockscout, fromAlchemy];

/**
 * Backstop TTL for the DATA cache only — deliberately not the CDN window, which
 * /api/stake-graph sets separately and much shorter (the CDN entry can't be
 * tag-invalidated, so it, not this, bounds cross-user staleness).
 *
 * Staking is a low-frequency event (a handful of deposits a day at most), so
 * what refreshes this is `revalidateTag("stake")` from the deposit/withdraw/
 * claim hooks, not the TTL expiring. The previous 60s put the repo's heaviest
 * server-side computation on a ~1440×/day treadmill for data that changes a few
 * times a day.
 *
 * Not exported: nothing outside this module should couple its own window to it.
 */
const GRAPH_TTL_SECONDS = 1800;

async function fetchStakeGraphUncached(): Promise<StakeGraph> {
  const live = RIDER_LIST.filter((r) => r.vault);
  if (live.length === 0)
    return {
      athletes: [],
      total: 0,
      backerCount: 0,
      // No live vaults means there was nothing to look up, not a lookup that failed.
      backersResolved: true,
      morResolved: true,
      gnarsAccrued: 0,
      gnarsMor: 0,
      gnarsMorUsd: 0,
      treasuryUsd: 0,
    };

  const ethUsd = await getEthUsd();
  const [athleteRows, mor] = await Promise.all([
    Promise.all(
      live.map(async (r): Promise<{ athlete: OrbitAthlete; complete: boolean }> => {
        const vault = r.vault as Address;
        const splitAddr = r.split ? getAddress(r.split) : undefined;

        // Vault-level truth first, in one call. It is also the cheapest possible
        // answer to "could anyone hold shares here?" — a vault with zero supply
        // needs NO indexer round-trip at all, which is four of the seven riders
        // today, and those four can never be degraded by an indexer outage.
        const head = await baseClient.multicall({
          allowFailure: true,
          contracts: [
            { address: vault, abi: vaultAbi, functionName: "totalAssets", args: [] },
            { address: vault, abi: vaultAbi, functionName: "totalSupply", args: [] },
          ] as Parameters<typeof baseClient.multicall>[0]["contracts"],
        });

        // `allowFailure` lets a genuinely empty vault (success, 0n) and a dead
        // RPC (failure, no result) both arrive here. Coercing the second to 0n
        // is what turns an outage into a plausible "nobody has staked" graph —
        // the exact shape of bug that gets cached and believed. Distinguish
        // them by `status` and let a real failure reach the route's catch.
        if (head[0].status === "failure" || head[1].status === "failure") {
          throw new Error(`stake-graph: vault reads failed for ${vault}`);
        }
        const totalAssets = (head[0].result as bigint | undefined) ?? BigInt(0);
        const totalSupply = (head[1].result as bigint | undefined) ?? BigInt(0);
        const toAssets = (shares: bigint) =>
          totalSupply > BigInt(0) ? (shares * totalAssets) / totalSupply : BigInt(0);

        let backers: OrbitBacker[] = [];
        let feeShares = BigInt(0);
        // No supply means no holders. That is a FACT about the vault, not a
        // lookup that came back empty — so it is complete by construction.
        let complete = totalSupply === BigInt(0);

        if (!complete) {
          for (const source of HOLDER_SOURCES) {
            const found = await source(vault);
            if (!found) continue; // this source is down — ask the next one
            const candidates = splitAddr ? found.filter((a) => a !== splitAddr) : found;

            const res = await baseClient.multicall({
              allowFailure: true,
              contracts: [
                ...candidates.map((a) => ({
                  address: vault,
                  abi: vaultAbi,
                  functionName: "balanceOf",
                  args: [a],
                })),
                ...(splitAddr
                  ? [
                      {
                        address: vault,
                        abi: vaultAbi,
                        functionName: "balanceOf",
                        args: [splitAddr],
                      },
                    ]
                  : []),
              ] as Parameters<typeof baseClient.multicall>[0]["contracts"],
            });

            const rows: OrbitBacker[] = [];
            let accounted = BigInt(0);
            candidates.forEach((addr, i) => {
              const shares = (res[i].result as bigint | undefined) ?? BigInt(0);
              if (shares <= BigInt(0)) return;
              accounted += shares;
              rows.push({
                address: addr,
                amount: Number(formatUnits(toAssets(shares), 6)),
                kind: "vault",
              });
            });
            const split = splitAddr
              ? ((res[candidates.length].result as bigint | undefined) ?? BigInt(0))
              : BigInt(0);
            accounted += split;

            // Did we account for the WHOLE vault? Holders are only discoverable
            // through transfer history, so a source that serves one page of that
            // history looks exactly like a vault with fewer backers. Summing the
            // shares we DID find against totalSupply is the one check that tells
            // the two apart — on a healthy vault they match to the wei.
            if (accounted >= totalSupply) {
              backers = rows;
              feeShares = split;
              complete = true;
              break;
            }
            // Partial answer: keep the fullest one seen, but let the next source
            // try to beat it. Showing some real backers beats showing none — it
            // just must not be labelled complete.
            if (rows.length > backers.length) {
              backers = rows;
              feeShares = split;
            }
          }
        }

        backers.sort((a, b) => b.amount - a.amount);

        return {
          athlete: {
            id: r.id,
            handle: r.handle,
            vault,
            split: r.split,
            vaultTvl: Number(formatUnits(totalAssets, 6)),
            // Both filled in below, once the MOR backers have been merged in.
            morUsd: 0,
            total: Number(formatUnits(totalAssets, 6)),
            feeAccrued: Number(formatUnits(toAssets(feeShares), 6)),
            backers,
          },
          complete,
        };
      }),
    ),
    readMorpheusBacking(ethUsd),
  ]);

  const athletes = athleteRows.map((x) => x.athlete);
  const backersResolved = athleteRows.every((x) => x.complete);

  for (const a of athletes) {
    const m = mor.byRider[a.id];
    if (m && m.length) {
      a.backers.push(...m);
      a.backers.sort((x, y) => y.amount - x.amount);
    }
    // Derived from the merged backer list rather than tracked separately, so
    // "what the node prints" and "what zooming into that node lists" cannot
    // disagree — they are now the same numbers read twice.
    a.morUsd = a.backers.reduce((s, b) => s + (b.kind === "mor" ? b.amount : 0), 0);
    a.total = a.vaultTvl + a.morUsd;
  }

  const distinct = new Set<string>();
  athletes.forEach((a) => a.backers.forEach((b) => distinct.add(b.address.toLowerCase())));

  const gnarsAccrued = athletes.reduce((s, a) => s + a.feeAccrued, 0) / 2; // vault fee, USDC≈USD
  const graph: StakeGraph = {
    athletes,
    // Plain sum now that `a.total` carries each rider's MOR. The headline used
    // to add `morTvl` on top of vault-only per-rider totals, which is exactly
    // what let it disagree with the nodes printed underneath it.
    total: athletes.reduce((s, a) => s + a.total, 0),
    backerCount: distinct.size,
    backersResolved,
    morResolved: mor.resolved,
    gnarsAccrued,
    gnarsMor: mor.mor,
    gnarsMorUsd: mor.morUsd,
    treasuryUsd: gnarsAccrued + mor.morUsd,
  };

  // Throwing is the ONLY way to keep a degraded graph out of `unstable_cache` —
  // the wrapper caches whatever the callback returns, and it cannot be told
  // "compute this but don't store it". So the partial graph rides out on the
  // error, and `loadStakeGraph` below decides what the page should show. The
  // Vault TVL remains exact from `totalAssets()`. Morpheus totals include only
  // verified principal reads and are explicitly partial when morResolved is false.
  if (!backersResolved || !mor.resolved) throw new StakeGraphDegradedError(graph);
  return graph;
}

/**
 * The cached entry point every caller should use. `StakeGraph` is plain
 * numbers/strings, so it survives the cache's JSON round-trip unchanged — no
 * re-hydration needed (contrast `services/proposals.ts`, which has to restore a
 * `Date`).
 */
export const getStakeGraph = unstable_cache(fetchStakeGraphUncached, ["stake-graph-v2"], {
  tags: [CACHE_TAGS.stake],
  revalidate: GRAPH_TTL_SECONDS,
});

/**
 * The last graph we knew to be complete, held in module memory.
 *
 * Deliberately NOT the data cache: the whole point is that a degraded graph
 * must not be persisted, and this survives only as long as the server instance
 * does. On a cold instance it is null and the degraded path falls back to the
 * partial graph, which is the honest worst case — TVL, no orbit, and a page
 * that says so.
 */
let lastCompleteGraph: StakeGraph | null = null;

function degradedGraphFrom(err: unknown): StakeGraph | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { isStakeGraphDegraded?: boolean; degradedGraph?: StakeGraph };
  return e.isStakeGraphDegraded && e.degradedGraph ? e.degradedGraph : null;
}

/**
 * What every caller should use. Failing loud must not mean failing the VISITOR:
 * an indexer being down is our problem, not a reason to hand someone an error
 * page where a page with real TVL would do.
 *
 * The order is: complete graph → last complete graph this instance saw →
 * partial graph flagged incomplete. Only a genuinely broken graph
 * (chain reads down, prices unavailable) throws on to the route's 500.
 *
 * `degraded` is returned separately from the payload because it governs
 * CACHING, not rendering: a degraded response must not be stored by the CDN
 * either, or the same empty orbit gets pinned for the whole s-maxage window —
 * the CDN being the one cache `revalidateTag` cannot reach.
 */
export async function loadStakeGraph(): Promise<{ graph: StakeGraph; degraded: boolean }> {
  try {
    const graph = await getStakeGraph();
    lastCompleteGraph = graph;
    return { graph, degraded: false };
  } catch (err) {
    const partial = degradedGraphFrom(err);
    if (!partial) throw err;
    // Stale-but-true beats fresh-but-blank: this graph's backers were really
    // there, minutes ago, which is far closer to the truth than an empty orbit.
    if (lastCompleteGraph) {
      return {
        graph: {
          ...lastCompleteGraph,
          backersResolved: partial.backersResolved,
          morResolved: partial.morResolved,
        },
        degraded: true,
      };
    }
    return { graph: partial, degraded: true };
  }
}
