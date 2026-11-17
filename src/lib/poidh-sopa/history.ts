import { displayAmount } from "@/lib/poidh-sopa/bounty-data";
import { previewPayouts } from "@/lib/poidh-sopa/shares";
import type { SopaBounty, SopaHistoryEntry, SopaHistoryWinner } from "@/lib/poidh-sopa/types";

/**
 * Finished Sopa bounties and what they paid, for the results section of
 * /community/bounties. Kept out of the service so the math is testable.
 */

export interface RawWinners {
  claimIds: readonly bigint[];
  sharesBps: readonly bigint[];
}

export interface RawClaim {
  claimer: `0x${string}`;
  name: string;
}

/**
 * One finished bounty with each winner's net payout: the bounty's paid total minus its
 * fee snapshot, split by share (the same math as the payout preview).
 */
export function buildHistoryEntry(
  bounty: SopaBounty,
  winners: RawWinners | null,
  feeBps: readonly number[] | null,
  claims: ReadonlyMap<number, RawClaim>,
): SopaHistoryEntry {
  if (!winners || !feeBps || winners.claimIds.length === 0) return { bounty, winners: [] };
  const shares = winners.sharesBps.map(Number);
  const payouts = previewPayouts(BigInt(displayAmount(bounty)), shares, [...feeBps]);
  const rows: SopaHistoryWinner[] = [];
  winners.claimIds.forEach((id, i) => {
    const claim = claims.get(Number(id));
    if (!claim) return;
    rows.push({
      claimId: Number(id),
      claimer: claim.claimer,
      name: claim.name,
      shareBps: shares[i],
      amount: payouts[i].toString(),
    });
  });
  // A winner whose claim could not be read would make the split look complete when it
  // is not: show the bounty without winners instead.
  return { bounty, winners: rows.length === winners.claimIds.length ? rows : [] };
}

/** Paid bounties, newest first. */
export function paidBounties(bounties: readonly SopaBounty[]): SopaBounty[] {
  return bounties.filter((b) => b.status === "paid").sort((a, b) => b.createdAt - a.createdAt);
}

export interface HistorySummary {
  /** Bounties paid out. */
  finished: number;
  /** Distinct winning wallets. */
  winners: number;
  /** Net amount paid to winners, by reward token (lowercased address → raw units). */
  paidByToken: Map<string, bigint>;
  /** Some finished bounty has no readable winners: the totals undercount. */
  incomplete: boolean;
}

export function summarizeHistory(entries: readonly SopaHistoryEntry[]): HistorySummary {
  const wallets = new Set<string>();
  const paidByToken = new Map<string, bigint>();
  let incomplete = false;
  for (const { bounty, winners } of entries) {
    if (winners.length === 0) incomplete = true;
    const key = bounty.token.toLowerCase();
    for (const w of winners) {
      wallets.add(w.claimer.toLowerCase());
      paidByToken.set(key, (paidByToken.get(key) ?? 0n) + BigInt(w.amount));
    }
  }
  return { finished: entries.length, winners: wallets.size, paidByToken, incomplete };
}
