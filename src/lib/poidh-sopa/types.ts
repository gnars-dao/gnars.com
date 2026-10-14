/**
 * Serializable PoidhSopa shapes (amounts are decimal strings of raw token units, so
 * they survive JSON, `unstable_cache` and React Query unchanged).
 */

export type SopaStatus = "open" | "voting" | "cancelled" | "paid";

export interface SopaBounty {
  /** On-chain bounty id (starts at 0; collides with V3 ids, hence the /sopa route). */
  id: number;
  issuer: `0x${string}`;
  /** Reward token; `0x000…0` = ETH. */
  token: `0x${string}`;
  title: string;
  description: string;
  /** Raw token units, current escrowed amount (0 once paid/cancelled). */
  amount: string;
  /** Amount at creation, from `BountyCreated` (null when the log was not found). */
  createdAmount: string | null;
  /**
   * Total paid out, for paid open bounties: the sum of participant contributions (the
   * contract zeroes `amount` and `createdAmount` is only the issuer's deposit). Null
   * otherwise or when unknown.
   */
  paidAmount: string | null;
  /** Unix seconds. */
  createdAt: number;
  /** null = unknown (creation log not found and not resolvable from participants). */
  isOpenBounty: boolean | null;
  /** Category slug from `BountyCreated`; null when the log was not found. */
  category: string | null;
  status: SopaStatus;
}

export interface SopaClaim {
  id: number;
  issuer: `0x${string}`;
  bountyId: number;
  name: string;
  description: string;
  createdAt: number;
  accepted: boolean;
  /** Claim NFT tokenURI (the proof media URL), null when unreadable. */
  uri: string | null;
}

export interface SopaShare {
  claimId: number;
  shareBps: number;
}

export interface SopaParticipant {
  address: `0x${string}`;
  /** Raw token units. */
  amount: string;
}

export interface SopaVotes {
  /** Raw token units of contribution weight. */
  yes: string;
  no: string;
  /** Unix seconds. 0 = no vote. */
  deadline: number;
}

export interface SopaBountyDetail extends SopaBounty {
  claims: SopaClaim[];
  /** Active participant slots only (withdrawn slots dropped). Empty for solo bounties. */
  participants: SopaParticipant[];
  everHadExternalContributor: boolean;
  winners: SopaShare[];
  proposal: SopaShare[];
  votes: SopaVotes | null;
  /**
   * Lowercased addresses that already voted in the current round (from `VoteCast` logs;
   * the issuer's automatic yes emits no event). Null when no vote is active or the logs
   * could not be read.
   */
  voters: string[] | null;
  /** Fee rates snapshotted at creation (`bountyFees`), in bps. */
  fees: { poidhBps: number; sopaBps: number };
}

export interface SopaBountiesResult {
  bounties: SopaBounty[];
  /** Set when the read failed — render as a failure, never as "no bounties". */
  error: string | null;
  /**
   * Some creation-log chunks failed: rows may lack category / open-solo. Never cache
   * (CDN, ISR, client initialData) a partial result.
   */
  partial?: boolean;
}
