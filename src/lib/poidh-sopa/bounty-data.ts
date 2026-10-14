import { zeroAddress } from "viem";
import type { SopaBounty, SopaStatus } from "./types";

/**
 * Status from the on-chain `Bounty.claimer`:
 * - `0x0`             → active (voting when a winners proposal is pending)
 * - `== issuer`       → cancelled
 * - `== the contract` → paid (one or more winners)
 */
export function deriveSopaStatus(input: {
  claimer: string;
  issuer: string;
  contractAddress: string;
  hasActiveProposal: boolean;
}): SopaStatus {
  const claimer = input.claimer.toLowerCase();
  if (claimer === input.issuer.toLowerCase()) return "cancelled";
  if (claimer === input.contractAddress.toLowerCase()) return "paid";
  if (claimer !== zeroAddress) return "paid"; // unreachable in PoidhSopa; treat as finalized
  return input.hasActiveProposal ? "voting" : "open";
}

/** `bounties(i)` tuple as viem returns it. */
export type SopaBountyTuple = readonly [
  id: bigint,
  issuer: `0x${string}`,
  token: `0x${string}`,
  name: string,
  description: string,
  amount: bigint,
  claimer: `0x${string}`,
  createdAt: bigint,
];

/** Decoded `BountyCreated` args we keep. */
export interface SopaCreatedLog {
  id: number;
  amount: string;
  isOpenBounty: boolean;
  category: string;
}

export interface SopaBountyRow {
  tuple: SopaBountyTuple;
  hasActiveProposal: boolean;
}

/**
 * Merges contract rows with creation logs by id. Rows are the truth for live state
 * (amount, claimer); logs add what the struct does not store (category, open/solo).
 * `openFallback` answers open/solo for rows whose log was not found.
 * Output is newest first.
 */
export function mergeSopaBounties(
  rows: SopaBountyRow[],
  logs: SopaCreatedLog[],
  contractAddress: string,
  openFallback: Map<number, boolean> = new Map(),
): SopaBounty[] {
  const byId = new Map<number, SopaCreatedLog>();
  for (const log of logs) byId.set(log.id, log);

  return rows
    .map(({ tuple, hasActiveProposal }) => {
      const [id, issuer, token, name, description, amount, claimer, createdAt] = tuple;
      const numericId = Number(id);
      const log = byId.get(numericId);
      return {
        id: numericId,
        issuer,
        token,
        title: name,
        description,
        amount: amount.toString(),
        createdAmount: log?.amount ?? null,
        paidAmount: null,
        createdAt: Number(createdAt),
        isOpenBounty: log ? log.isOpenBounty : (openFallback.get(numericId) ?? null),
        category: log?.category ?? null,
        status: deriveSopaStatus({ claimer, issuer, contractAddress, hasActiveProposal }),
      } satisfies SopaBounty;
    })
    .filter((b) => b.issuer !== zeroAddress)
    .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
}

/**
 * The reward to show: live escrow while active; once closed, what was paid out (paid open
 * bounties: participant sum) or else the creation amount.
 */
export function displayAmount(
  bounty: Pick<SopaBounty, "amount" | "createdAmount"> & { paidAmount?: string | null },
): string {
  if (BigInt(bounty.amount) > 0n) return bounty.amount;
  return bounty.paidAmount ?? bounty.createdAmount ?? bounty.amount;
}

/** Sum of raw participant amounts (paid open bounties keep them on-chain). */
export function sumAmounts(amounts: readonly (bigint | string)[]): string {
  return amounts.reduce<bigint>((sum, a) => sum + BigInt(a), 0n).toString();
}
