import "server-only";
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { createPublicClient, fallback, http, zeroAddress, type PublicClient } from "viem";
import { base } from "viem/chains";
import { POIDH_SOPA } from "@/lib/config";
import { BASE_RPCS } from "@/lib/morpheus-builder";
import { POIDH_CLAIM_NFT_ABI, POIDH_SOPA_ABI } from "@/lib/poidh-sopa/abi";
import {
  chunkRangesForTimestamps,
  ESTIMATE_MARGIN_BLOCKS,
  estimateBlockAt,
  LOG_CHUNK_BLOCKS,
  type BlockRange,
} from "@/lib/poidh-sopa/blocks";
import {
  deriveSopaStatus,
  mergeSopaBounties,
  sumAmounts,
  type SopaBountyRow,
  type SopaBountyTuple,
  type SopaCreatedLog,
} from "@/lib/poidh-sopa/bounty-data";
import type {
  SopaBountiesResult,
  SopaBounty,
  SopaBountyDetail,
  SopaClaim,
  SopaParticipant,
  SopaShare,
} from "@/lib/poidh-sopa/types";

/**
 * PoidhSopa data access — RPC only (no subgraph). Kept behind this module so an
 * indexer can replace it without touching callers:
 *
 * - list: `bountyCounter` + multicall `bounties(i)` / `getCurrentProposal(i)`, merged
 *   with `BountyCreated` logs (category + open/solo, which the struct does not store).
 *   Logs are fetched only for the deploy-aligned 10k-block chunks that can contain each
 *   bounty's creation (estimated from `createdAt`), and finalized chunks are cached for a
 *   day. `getBounties(offset)` is NOT used: its paging is broken upstream.
 * - detail: struct + participants + claims (`bountyClaims(id, i)` + `claims(cid)` +
 *   claim NFT `tokenURI`) + winners / proposal / votes.
 */

const LIST_LIMIT = 200;
const LIST_TTL_SECONDS = 60;
const FINALIZED_CHUNK_TTL_SECONDS = 86_400;
/** A chunk ending this many blocks behind head is treated as final (~30 min on Base). */
const FINALITY_BLOCKS = 900n;
const CLAIM_PAGE = 25;
const MAX_CLAIMS = 500;

function rpcUrls(): string[] {
  const own = [process.env.BASE_RPC, process.env.NEXT_PUBLIC_BASE_RPC_URL].filter(
    (u): u is string => Boolean(u && u.startsWith("http")),
  );
  return [...new Set([...own, ...BASE_RPCS])];
}

let client: PublicClient | null = null;
function getClient(): PublicClient {
  if (!client) {
    client = createPublicClient({
      chain: base,
      transport: fallback(rpcUrls().map((u) => http(u, { timeout: 10_000 }))),
      batch: { multicall: true },
    }) as PublicClient;
  }
  return client;
}

function contractAddress(): `0x${string}` | null {
  return POIDH_SOPA.address;
}

// ─── Creation logs ───────────────────────────────────────────────────────────

const BOUNTY_CREATED_EVENT = POIDH_SOPA_ABI.find(
  (x) => x.type === "event" && x.name === "BountyCreated",
)!;

async function fetchCreatedLogsInRange(
  address: `0x${string}`,
  range: { fromBlock: string; toBlock: string },
): Promise<SopaCreatedLog[]> {
  const logs = await getClient().getLogs({
    address,
    event: BOUNTY_CREATED_EVENT as Extract<
      (typeof POIDH_SOPA_ABI)[number],
      { type: "event"; name: "BountyCreated" }
    >,
    fromBlock: BigInt(range.fromBlock),
    toBlock: BigInt(range.toBlock),
    strict: true,
  });
  return logs.map((l) => ({
    id: Number(l.args.id),
    amount: l.args.amount.toString(),
    isOpenBounty: l.args.isOpenBounty,
    category: l.args.category,
  }));
}

/** Finalized ranges never change: cache them for a day (keyed by range). */
const fetchFinalizedCreatedLogs = unstable_cache(
  async (address: `0x${string}`, fromBlock: string, toBlock: string) =>
    fetchCreatedLogsInRange(address, { fromBlock, toBlock }),
  ["poidh-sopa-created-logs-v1"],
  { revalidate: FINALIZED_CHUNK_TTL_SECONDS },
);

async function fetchCreatedLogs(
  address: `0x${string}`,
  ranges: BlockRange[],
  latest: bigint,
): Promise<{ logs: SopaCreatedLog[]; failed: boolean }> {
  let failed = false;
  const results = await Promise.all(
    ranges.map(async (r) => {
      const from = r.fromBlock.toString();
      const to = r.toBlock.toString();
      try {
        return r.toBlock + FINALITY_BLOCKS <= latest
          ? await fetchFinalizedCreatedLogs(address, from, to)
          : await fetchCreatedLogsInRange(address, { fromBlock: from, toBlock: to });
      } catch (err) {
        console.error("[poidh-sopa] getLogs failed", from, to, err);
        failed = true;
        return [];
      }
    }),
  );
  return { logs: results.flat(), failed };
}

// ─── List ────────────────────────────────────────────────────────────────────

/**
 * Paid open bounties: `amount` is zeroed and the creation log only holds the issuer's
 * deposit, so the paid total is the sum of participant amounts (kept on-chain).
 */
async function withPaidAmounts(
  address: `0x${string}`,
  bounties: SopaBounty[],
): Promise<SopaBounty[]> {
  const paidOpen = bounties.filter((b) => b.status === "paid" && b.isOpenBounty !== false);
  if (paidOpen.length === 0) return bounties;
  const parts = await getClient().multicall({
    allowFailure: true,
    contracts: paidOpen.map((b) => ({
      address,
      abi: POIDH_SOPA_ABI,
      functionName: "getParticipants" as const,
      args: [BigInt(b.id)] as const,
    })),
  });
  const paid = new Map<number, string>();
  parts.forEach((p, i) => {
    if (p.status !== "success") return;
    const [addrs, amounts] = p.result as unknown as readonly [
      readonly unknown[],
      readonly bigint[],
    ];
    if (addrs.length > 0) paid.set(paidOpen[i].id, sumAmounts(amounts));
  });
  return bounties.map((b) => (paid.has(b.id) ? { ...b, paidAmount: paid.get(b.id)! } : b));
}

/** List read plus whether any creation-log chunk failed (categories may be missing). */
type SopaBountiesRead = SopaBountiesResult & { partial: boolean };

/**
 * Thrown inside the cached reader so a partial read (some `getLogs` chunks failed) is
 * never pinned for the TTL. Carries the partial result so callers can still render it.
 */
class PartialSopaReadError extends Error {
  constructor(readonly result: SopaBountiesResult) {
    super("Sopa bounty list read was partial");
    this.name = "PartialSopaReadError";
  }
}

async function readSopaBountiesUncached(): Promise<SopaBountiesRead> {
  const address = contractAddress();
  if (!address) return { bounties: [], error: null, partial: false };
  const rpc = getClient();

  try {
    const [counter, head] = await Promise.all([
      rpc.readContract({ address, abi: POIDH_SOPA_ABI, functionName: "bountyCounter" }),
      rpc.getBlock({ blockTag: "latest" }),
    ]);
    const count = Number(counter);
    if (count === 0) return { bounties: [], error: null, partial: false };

    const start = Math.max(0, count - LIST_LIMIT);
    const ids = Array.from({ length: count - start }, (_, i) => BigInt(start + i));

    const [structs, proposals] = await Promise.all([
      rpc.multicall({
        allowFailure: false,
        contracts: ids.map((id) => ({
          address,
          abi: POIDH_SOPA_ABI,
          functionName: "bounties" as const,
          args: [id] as const,
        })),
      }),
      rpc.multicall({
        allowFailure: false,
        contracts: ids.map((id) => ({
          address,
          abi: POIDH_SOPA_ABI,
          functionName: "getCurrentProposal" as const,
          args: [id] as const,
        })),
      }),
    ]);

    const rows: SopaBountyRow[] = structs.map((tuple, i) => ({
      tuple: tuple as unknown as SopaBountyTuple,
      hasActiveProposal:
        (proposals[i] as readonly [readonly bigint[], readonly bigint[]])[0].length > 0,
    }));

    const ranges = chunkRangesForTimestamps(
      rows.map((r) => Number(r.tuple[7])),
      {
        deployBlock: POIDH_SOPA.deployBlock,
        latest: { number: head.number, timestamp: Number(head.timestamp) },
      },
    );
    const { logs, failed } = await fetchCreatedLogs(address, ranges, head.number);

    // Open/solo for rows whose creation log was not found: open bounties always have
    // participant slots (the issuer at index 0), solo bounties have none.
    const found = new Set(logs.map((l) => l.id));
    const missing = ids.filter((id) => !found.has(Number(id)));
    const openFallback = new Map<number, boolean>();
    if (missing.length > 0) {
      const parts = await rpc.multicall({
        allowFailure: true,
        contracts: missing.map((id) => ({
          address,
          abi: POIDH_SOPA_ABI,
          functionName: "getParticipants" as const,
          args: [id] as const,
        })),
      });
      parts.forEach((p, i) => {
        if (p.status === "success") {
          openFallback.set(
            Number(missing[i]),
            (p.result as unknown as readonly [readonly unknown[]])[0].length > 0,
          );
        }
      });
    }

    const merged = mergeSopaBounties(rows, logs, address, openFallback);
    const bounties = await withPaidAmounts(address, merged);
    return { bounties, error: null, partial: failed };
  } catch (err) {
    console.error("[poidh-sopa] list read failed", err);
    return { bounties: [], error: "Sopa bounties could not be read from Base.", partial: false };
  }
}

// The contract address is an argument so it is part of the cache key: a new deploy (or a
// local fork) never serves another contract's cached list.
const readSopaBountiesCached = unstable_cache(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- cache-key only
  async (_address: `0x${string}`) => {
    const { partial, ...result } = await readSopaBountiesUncached();
    // A failed read must not be pinned for a TTL as if it were "no bounties".
    if (result.error) throw new Error(result.error);
    // Neither may a partial one (rows without categories): serve it uncached instead.
    if (partial) throw new PartialSopaReadError(result);
    return result;
  },
  ["poidh-sopa-bounties-v1"],
  { revalidate: LIST_TTL_SECONDS },
);

export const fetchSopaBounties = cache(async (): Promise<SopaBountiesResult> => {
  if (!contractAddress()) return { bounties: [], error: null };
  try {
    return await readSopaBountiesCached(contractAddress()!);
  } catch (err) {
    // Checked by name too: the cache layer may rethrow across module instances.
    if (err instanceof PartialSopaReadError) return { ...err.result, partial: true };
    if (err instanceof Error && err.name === "PartialSopaReadError" && "result" in err) {
      return { ...(err as PartialSopaReadError).result, partial: true };
    }
    return {
      bounties: [],
      error: err instanceof Error ? err.message : "Sopa bounties could not be read.",
    };
  }
});

// ─── Detail ──────────────────────────────────────────────────────────────────

async function readClaimIds(address: `0x${string}`, bountyId: bigint): Promise<bigint[]> {
  const rpc = getClient();
  const ids: bigint[] = [];
  for (let offset = 0; offset < MAX_CLAIMS; offset += CLAIM_PAGE) {
    const page = await rpc.multicall({
      allowFailure: true,
      contracts: Array.from({ length: CLAIM_PAGE }, (_, i) => ({
        address,
        abi: POIDH_SOPA_ABI,
        functionName: "bountyClaims" as const,
        args: [bountyId, BigInt(offset + i)] as const,
      })),
    });
    for (const r of page) {
      // Out-of-range index reverts: the array has ended.
      if (r.status !== "success") return ids;
      ids.push(r.result as bigint);
    }
  }
  return ids;
}

type ClaimTuple = readonly [
  id: bigint,
  issuer: `0x${string}`,
  bountyId: bigint,
  bountyIssuer: `0x${string}`,
  name: string,
  description: string,
  createdAt: bigint,
  accepted: boolean,
];

async function readClaims(address: `0x${string}`, bountyId: bigint): Promise<SopaClaim[]> {
  const rpc = getClient();
  const claimIds = await readClaimIds(address, bountyId);
  if (claimIds.length === 0) return [];
  const nft = await rpc.readContract({ address, abi: POIDH_SOPA_ABI, functionName: "poidhNft" });

  const [structs, uris] = await Promise.all([
    rpc.multicall({
      allowFailure: false,
      contracts: claimIds.map((cid) => ({
        address,
        abi: POIDH_SOPA_ABI,
        functionName: "claims" as const,
        args: [cid] as const,
      })),
    }),
    rpc.multicall({
      allowFailure: true,
      contracts: claimIds.map((cid) => ({
        address: nft,
        abi: POIDH_CLAIM_NFT_ABI,
        functionName: "tokenURI" as const,
        args: [cid] as const,
      })),
    }),
  ]);

  return structs.map((raw, i) => {
    const c = raw as unknown as ClaimTuple;
    const uri = uris[i];
    return {
      id: Number(c[0]),
      issuer: c[1],
      bountyId: Number(c[2]),
      name: c[4],
      description: c[5],
      createdAt: Number(c[6]),
      accepted: c[7],
      uri: uri.status === "success" && uri.result ? (uri.result as string) : null,
    };
  });
}

const VOTE_CAST_EVENT = POIDH_SOPA_ABI.find((x) => x.type === "event" && x.name === "VoteCast")!;

/**
 * Who already voted in the current round: `VoteCast` logs for this bounty from the vote
 * start (deadline - votingPeriod, estimated to a block) to head, filtered by round.
 * `lastVotedRound` is private on-chain, so logs are the only source. Null on any failure
 * so the UI falls back to letting the contract reject a second vote.
 */
async function readVotersThisRound(
  address: `0x${string}`,
  bountyId: bigint,
  deadline: bigint,
  head: { number: bigint; timestamp: bigint },
): Promise<string[] | null> {
  const rpc = getClient();
  try {
    const [round, period] = await Promise.all([
      rpc.readContract({
        address,
        abi: POIDH_SOPA_ABI,
        functionName: "voteRound",
        args: [bountyId],
      }),
      rpc.readContract({ address, abi: POIDH_SOPA_ABI, functionName: "votingPeriod" }),
    ]);
    const start = estimateBlockAt(Number(deadline - (period as bigint)), {
      number: head.number,
      timestamp: Number(head.timestamp),
    });
    let from = start > ESTIMATE_MARGIN_BLOCKS ? start - ESTIMATE_MARGIN_BLOCKS : 0n;
    if (from < POIDH_SOPA.deployBlock) from = POIDH_SOPA.deployBlock;

    const voters = new Set<string>();
    for (let lo = from; lo <= head.number; lo += LOG_CHUNK_BLOCKS) {
      const hi =
        lo + LOG_CHUNK_BLOCKS - 1n > head.number ? head.number : lo + LOG_CHUNK_BLOCKS - 1n;
      const logs = await rpc.getLogs({
        address,
        event: VOTE_CAST_EVENT as Extract<
          (typeof POIDH_SOPA_ABI)[number],
          { type: "event"; name: "VoteCast" }
        >,
        args: { bountyId },
        fromBlock: lo,
        toBlock: hi,
        strict: true,
      });
      for (const l of logs) {
        if (l.args.round === round) voters.add(l.args.voter.toLowerCase());
      }
    }
    return [...voters];
  } catch (err) {
    console.error("[poidh-sopa] VoteCast read failed", bountyId, err);
    return null;
  }
}

function toShares(ids: readonly bigint[], bps: readonly bigint[]): SopaShare[] {
  return ids.map((id, i) => ({ claimId: Number(id), shareBps: Number(bps[i] ?? 0n) }));
}

/** Uncached on purpose: the detail page refetches right after a write. */
export async function fetchSopaBountyFresh(id: number): Promise<SopaBountyDetail | null> {
  const address = contractAddress();
  if (!address || !Number.isInteger(id) || id < 0) return null;
  const rpc = getClient();
  const bid = BigInt(id);

  const counter = await rpc.readContract({
    address,
    abi: POIDH_SOPA_ABI,
    functionName: "bountyCounter",
  });
  if (bid >= counter) return null;

  const [struct, participants, external, winners, proposal, votes, fees, head] = await Promise.all([
    rpc.readContract({ address, abi: POIDH_SOPA_ABI, functionName: "bounties", args: [bid] }),
    rpc.readContract({
      address,
      abi: POIDH_SOPA_ABI,
      functionName: "getParticipants",
      args: [bid],
    }),
    rpc.readContract({
      address,
      abi: POIDH_SOPA_ABI,
      functionName: "everHadExternalContributor",
      args: [bid],
    }),
    rpc.readContract({ address, abi: POIDH_SOPA_ABI, functionName: "getWinners", args: [bid] }),
    rpc.readContract({
      address,
      abi: POIDH_SOPA_ABI,
      functionName: "getCurrentProposal",
      args: [bid],
    }),
    rpc.readContract({
      address,
      abi: POIDH_SOPA_ABI,
      functionName: "bountyVotingTracker",
      args: [bid],
    }),
    rpc.readContract({ address, abi: POIDH_SOPA_ABI, functionName: "bountyFees", args: [bid] }),
    rpc.getBlock({ blockTag: "latest" }),
  ]);

  const tuple = struct as unknown as SopaBountyTuple;
  const [pAddrs, pAmounts] = participants as unknown as readonly [
    readonly `0x${string}`[],
    readonly bigint[],
  ];
  const isOpenBounty = pAddrs.length > 0;
  const proposalShares = toShares(
    ...(proposal as unknown as readonly [readonly bigint[], readonly bigint[]]),
  );
  const [yes, no, deadline] = votes as unknown as readonly [bigint, bigint, bigint];
  const [poidhBps, sopaBps] = fees as unknown as readonly [number, number];

  const ranges = chunkRangesForTimestamps([Number(tuple[7])], {
    deployBlock: POIDH_SOPA.deployBlock,
    latest: { number: head.number, timestamp: Number(head.timestamp) },
  });
  const [{ logs }, claims, voters] = await Promise.all([
    fetchCreatedLogs(address, ranges, head.number),
    readClaims(address, bid),
    proposalShares.length > 0 && deadline > 0n
      ? readVotersThisRound(address, bid, deadline, head)
      : Promise.resolve(null),
  ]);
  const log = logs.find((l) => l.id === id);

  const activeParticipants: SopaParticipant[] = pAddrs
    .map((a, i) => ({ address: a, amount: (pAmounts[i] ?? 0n).toString() }))
    .filter((p) => p.address !== zeroAddress && BigInt(p.amount) > 0n);

  return {
    id,
    issuer: tuple[1],
    token: tuple[2],
    title: tuple[3],
    description: tuple[4],
    amount: tuple[5].toString(),
    createdAmount: log?.amount ?? null,
    paidAmount:
      isOpenBounty && tuple[6].toLowerCase() === address.toLowerCase()
        ? sumAmounts(pAmounts)
        : null,
    createdAt: Number(tuple[7]),
    isOpenBounty: log ? log.isOpenBounty : isOpenBounty,
    category: log?.category ?? null,
    status: deriveSopaStatus({
      claimer: tuple[6],
      issuer: tuple[1],
      contractAddress: address,
      hasActiveProposal: proposalShares.length > 0,
    }),
    claims,
    participants: activeParticipants,
    // Paid open bounties keep their participant amounts: their sum is what was paid out.
    everHadExternalContributor: external as boolean,
    winners: toShares(...(winners as unknown as readonly [readonly bigint[], readonly bigint[]])),
    proposal: proposalShares,
    votes:
      deadline > 0n ? { yes: yes.toString(), no: no.toString(), deadline: Number(deadline) } : null,
    voters,
    fees: { poidhBps: Number(poidhBps), sopaBps: Number(sopaBps) },
  };
}

/** Server render: per-request dedupe (generateMetadata + page). */
export const fetchSopaBounty = cache(async (id: number) => {
  try {
    return await fetchSopaBountyFresh(id);
  } catch (err) {
    console.error("[poidh-sopa] detail read failed", id, err);
    throw err;
  }
});
