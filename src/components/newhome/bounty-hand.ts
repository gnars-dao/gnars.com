import { formatEther, formatUnits } from "viem";
import { isPoidhSopaTeamIssuer, type PoidhSopaToken } from "@/lib/config";
import { findSopaToken, isEthToken } from "@/lib/poidh-sopa/tokens";
import type { SopaBounty } from "@/lib/poidh-sopa/types";
import { classifyGnarsDiscipline, type GnarsDiscipline } from "@/lib/poidh/keywords";
import type { PoidhBounty } from "@/types/poidh";

/**
 * The homepage showcases the two disciplines the brand is built on. `poidh`'s
 * Gnarly filter is broader than that — it also passes parkour and 420 bounties —
 * so the showcase narrows it again here rather than in the shared service, which
 * other surfaces (the /community/bounties index) still want wide.
 */
export const SHOWCASE_DISCIPLINES: GnarsDiscipline[] = ["skate", "surf"];

/** Short code shown on the card, e.g. `SK8-25`. */
export const DISCIPLINE_CODE: Record<GnarsDiscipline, string> = {
  skate: "SK8",
  surf: "SURF",
  parkour: "PARK",
  weed: "420",
};

export interface ShowcaseBounty {
  bounty: PoidhBounty;
  discipline: GnarsDiscipline;
  eth: number;
}

/**
 * Skate and surf bounties only, richest first.
 */
export function selectShowcaseBounties(bounties: PoidhBounty[]): ShowcaseBounty[] {
  return bounties
    .flatMap((bounty) => {
      const discipline = classifyGnarsDiscipline(
        `${bounty.title || bounty.name} ${bounty.description}`,
      );
      if (!discipline || !SHOWCASE_DISCIPLINES.includes(discipline)) return [];
      return [{ bounty, discipline, eth: Number(formatEther(BigInt(bounty.amount))) }];
    })
    .sort((a, b) => b.eth - a.eth);
}

/** An open Sopa bounty with its reward parsed once, for ranking, totals and the card. */
export interface SopaShowcase {
  bounty: SopaBounty;
  /** Undefined for a token missing from `POIDH_SOPA.tokens`. */
  token: PoidhSopaToken | undefined;
  /** Reward in whole token units. */
  amount: number;
  /** Issued by a `POIDH_SOPA.teamIssuers` wallet. */
  team: boolean;
}

export type HandEntry =
  | { kind: "sopa"; sopa: SopaShowcase }
  | { kind: "poidh"; item: ShowcaseBounty };

/** Open Sopa bounties only, every category: they were created on this site. */
export function selectSopaShowcase(
  bounties: SopaBounty[],
  isTeam: (issuer: string) => boolean = isPoidhSopaTeamIssuer,
): SopaShowcase[] {
  return bounties
    .filter((b) => b.status === "open")
    .map((bounty) => {
      const token = findSopaToken(bounty.token);
      return {
        bounty,
        token,
        amount: Number(formatUnits(BigInt(bounty.amount), token?.decimals ?? 18)),
        team: isTeam(bounty.issuer),
      };
    });
}

/** Reward in ETH, or null for a non-ETH reward. */
function entryEth(entry: HandEntry): number | null {
  if (entry.kind === "poidh") return entry.item.eth;
  const { token, amount } = entry.sopa;
  return token && isEthToken(token.address) ? amount : null;
}

/** Reward in USD, or null when it cannot be known (no ETH price, unknown token). */
export function entryUsd(entry: HandEntry, ethPrice: number): number | null {
  const eth = entryEth(entry);
  if (eth !== null) return ethPrice > 0 ? eth * ethPrice : null;
  if (entry.kind === "sopa" && entry.sopa.token?.symbol === "USDC") return entry.sopa.amount;
  return null;
}

/**
 * The hand's order. Team bounties lead, newest first: on the Gnars site the team's
 * own challenges are the headline. Everything else (community Sopa bounties and
 * poidh skate/surf) competes on reward value, so a 1-wei bounty from anyone sinks
 * to the back instead of taking the Legendary slot. Without an ETH price, ETH
 * rewards rank among themselves and the rest follow.
 */
export function rankHand(
  sopa: SopaShowcase[],
  showcase: ShowcaseBounty[],
  ethPrice: number,
): HandEntry[] {
  const team: HandEntry[] = sopa
    .filter((s) => s.team)
    .sort((a, b) => b.bounty.createdAt - a.bounty.createdAt)
    .map((s) => ({ kind: "sopa", sopa: s }));
  const key = (e: HandEntry) =>
    (ethPrice > 0 ? entryUsd(e, ethPrice) : entryEth(e)) ?? Number.NEGATIVE_INFINITY;
  const rest: HandEntry[] = [
    ...sopa.filter((s) => !s.team).map((s) => ({ kind: "sopa" as const, sopa: s })),
    ...showcase.map((item) => ({ kind: "poidh" as const, item })),
  ].sort((a, b) => key(b) - key(a));
  return [...team, ...rest];
}

/** ETH rewards in ETH, USDC rewards at face value in USD. */
export function handTotals(entries: HandEntry[]): { eth: number; stableUsd: number } {
  let eth = 0;
  let stableUsd = 0;
  for (const e of entries) {
    const value = entryEth(e);
    if (value !== null) eth += value;
    else stableUsd += entryUsd(e, 0) ?? 0;
  }
  return { eth, stableUsd };
}

/**
 * Card code for a Sopa bounty. The `GN-` prefix keeps it apart from poidh codes:
 * Sopa ids start at 0 and overlap poidh's, and without it a Sopa and a poidh skate
 * bounty #5 both printed `SK8-05` in the legend.
 */
export function sopaCode(bounty: SopaBounty): string {
  const category = bounty.category ?? "";
  // `hasOwn`, not `in`: the slug is arbitrary on-chain text, and `constructor`
  // would otherwise resolve to an inherited function.
  const code = Object.hasOwn(DISCIPLINE_CODE, category)
    ? DISCIPLINE_CODE[category as GnarsDiscipline]
    : (category || "gnars").toUpperCase().slice(0, 5);
  return `GN-${code}-${String(bounty.id).padStart(2, "0")}`;
}
