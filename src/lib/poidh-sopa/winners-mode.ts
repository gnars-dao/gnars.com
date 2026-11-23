import type { SopaBountyDetail } from "./types";

export type WinnersMode = "pay" | "vote";

/**
 * Which ways the creator may settle a bounty, matching PoidhSopa (checked by
 * scripts/poidh-sopa-vote-sim.ts):
 * - solo: only `acceptClaims` (`submitWinnersForVote` reverts NotOpenBounty);
 * - open, team money only: either one;
 * - open with an outside contributor, ever: only a vote (`acceptClaims` reverts).
 */
export function allowedWinnersModes(
  bounty: Pick<SopaBountyDetail, "isOpenBounty" | "everHadExternalContributor">,
): readonly WinnersMode[] {
  if (!bounty.isOpenBounty) return ["pay"];
  if (bounty.everHadExternalContributor) return ["vote"];
  return ["pay", "vote"];
}
