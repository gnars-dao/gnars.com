import { formatUnits } from "viem";
import { isPoidhSopaTeamIssuer, POIDH_SOPA, type PoidhSopaToken } from "@/lib/config";
import { displayAmount } from "@/lib/poidh-sopa/bounty-data";
import { isEthToken } from "@/lib/poidh-sopa/tokens";
import type { SopaBounty, SopaStatus } from "@/lib/poidh-sopa/types";
import { classifyGnarsDiscipline, GNARS_DISCIPLINES } from "@/lib/poidh/keywords";
import type { PoidhBounty } from "@/types/poidh";

/**
 * The /community/bounties list logic, kept out of the component so it can be tested:
 * which bounties each section shows and what the pool stats add up to.
 */

export type BountyStatusFilter = "open" | "closed" | "voting" | "all";

const SOPA_STATUS_FOR_FILTER: Record<BountyStatusFilter, SopaStatus[] | null> = {
  open: ["open"],
  voting: ["voting"],
  closed: ["paid", "cancelled"],
  all: null,
};

function matchesQuery(bounty: { title: string; description: string }, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || `${bounty.title} ${bounty.description}`.toLowerCase().includes(q);
}

/** Team (Sopa) bounties: status and search apply; disciplines do not. */
export function filterTeamBounties(
  bounties: readonly SopaBounty[],
  { status, query }: { status: BountyStatusFilter; query: string },
): SopaBounty[] {
  const statuses = SOPA_STATUS_FOR_FILTER[status];
  return bounties.filter(
    (b) => (!statuses || statuses.includes(b.status)) && matchesQuery(b, query),
  );
}

/**
 * The contract is permissionless, so only bounties issued by a team wallet
 * (`POIDH_SOPA.teamIssuers`) are Gnars-sponsored and lead the page; anyone else's
 * Sopa bounty sits with the community ones.
 */
export function splitSponsored(
  bounties: readonly SopaBounty[],
  isSponsored: (issuer: string) => boolean = isPoidhSopaTeamIssuer,
): { sponsored: SopaBounty[]; community: SopaBounty[] } {
  const sponsored: SopaBounty[] = [];
  const community: SopaBounty[] = [];
  for (const b of bounties) (isSponsored(b.issuer) ? sponsored : community).push(b);
  return { sponsored, community };
}

/**
 * Community Sopa bounties: status, search and discipline all apply. The category the
 * creator picked counts when it is a discipline; otherwise the text is classified.
 */
export function filterCommunitySopaBounties(
  bounties: readonly SopaBounty[],
  { status, query, category }: { status: BountyStatusFilter; query: string; category: string },
): SopaBounty[] {
  return filterTeamBounties(bounties, { status, query }).filter((b) => {
    if (category === "all") return true;
    const picked = (GNARS_DISCIPLINES as readonly string[]).includes(b.category ?? "")
      ? b.category
      : classifyGnarsDiscipline(`${b.title} ${b.description}`);
    return picked === category;
  });
}

/** POIDH feed bounties: search, then the discipline when one is picked ("all" = any). */
export function filterCommunityBounties(
  bounties: readonly PoidhBounty[],
  { query, category }: { query: string; category: string },
): PoidhBounty[] {
  return bounties.filter(
    (b) =>
      matchesQuery(b, query) &&
      (category === "all" || classifyGnarsDiscipline(`${b.title} ${b.description}`) === category),
  );
}

export interface PoolSummary {
  /** POIDH and Sopa ETH rewards together, in wei. */
  totalWei: bigint;
  /** Sopa rewards in other tokens, by configured token. */
  others: { token: PoidhSopaToken; raw: bigint }[];
  /**
   * Everything in dollars: ETH at `ethPrice`, stablecoins at face. Null when there is ETH
   * to price and no price, so a failed price read never shows as a smaller number.
   */
  usd: number | null;
  count: number;
}

/** Sums exactly the bounties on screen, so the stats always describe the visible cards. */
export function summarizePool(
  community: readonly PoidhBounty[],
  team: readonly SopaBounty[],
  ethPrice: number,
  tokens: readonly PoidhSopaToken[] = POIDH_SOPA.tokens,
): PoolSummary {
  let totalWei = community.reduce((sum, b) => sum + BigInt(b.amount ?? 0), 0n);
  const byToken = new Map<string, bigint>();
  for (const b of team) {
    const amount = BigInt(displayAmount(b));
    if (isEthToken(b.token)) totalWei += amount;
    else {
      const key = b.token.toLowerCase();
      byToken.set(key, (byToken.get(key) ?? 0n) + amount);
    }
  }

  const others: PoolSummary["others"] = [];
  let stableUsd = 0;
  for (const [address, raw] of byToken) {
    const token = tokens.find((tk) => tk.address.toLowerCase() === address);
    if (!token) continue;
    others.push({ token, raw });
    if (token.usdStable) stableUsd += Number(formatUnits(raw, token.decimals));
  }

  const priced = totalWei === 0n || ethPrice > 0;
  return {
    totalWei,
    others,
    usd: priced ? Number(formatUnits(totalWei, 18)) * ethPrice + stableUsd : null,
    count: community.length + team.length,
  };
}

/** Balanced parentheses one level deep, so `(https://…/Foo_(bar))` stays one URL. */
const URL_PART = String.raw`\((?:[^()\s]|\([^()\s]*\))*\)`;
const MD_IMAGE = new RegExp(String.raw`!\[[^\]]*\]` + URL_PART, "g");
const MD_LINK = new RegExp(String.raw`\[([^\]]*)\]` + URL_PART, "g");

/** One-paragraph plain text for a card: images drop out, links keep their text. */
export function markdownPreview(text: string): string {
  return text
    .replace(MD_IMAGE, "")
    .replace(MD_LINK, "$1")
    .replace(/[#*_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Merges per-status lists newest first and keeps the first `limit`. */
export function mergeNewest<T extends { createdAt: number }>(
  lists: readonly (readonly T[])[],
  limit: number,
): T[] {
  return lists
    .flat()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}
