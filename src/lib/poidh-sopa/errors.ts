/**
 * Maps a write error to a translation key under `bounties.sopa.errors`. Contract
 * custom errors are matched by name in the message (viem and thirdweb both include it).
 */
export const SOPA_ERROR_KEYS = [
  "AlreadyVoted",
  "AmountMismatch",
  "BountyClaimed",
  "BountyClosed",
  "BountyNotFound",
  "ClaimAlreadyAccepted",
  "ClaimNotFound",
  "DuplicateWinner",
  "InsufficientBalance",
  "InvalidCategory",
  "InvalidToken",
  "InvalidWinners",
  "IssuerCannotClaim",
  "IssuerCannotWithdraw",
  "MaxParticipantsReached",
  "MinimumBountyNotMet",
  "MinimumContributionNotMet",
  "NoEther",
  "NoVotingPeriodSet",
  "NotActiveParticipant",
  "NotCancelledOpenBounty",
  "NotOpenBounty",
  "NotSoloBounty",
  "NothingToWithdraw",
  "SharesMustSumToDenom",
  "TransferFailed",
  "UnexpectedEther",
  "VoteWouldPass",
  "VotingEnded",
  "VotingOngoing",
  "WrongCaller",
  "ZeroAmount",
  "ZeroShare",
] as const;

export type SopaErrorKey = (typeof SOPA_ERROR_KEYS)[number] | "userRejected" | "insufficientFunds";

export interface DecodedSopaError {
  /** Translation key under `bounties.sopa.errors`, or null for an unknown error. */
  key: SopaErrorKey | null;
  /** First line of the raw message, for unknown errors. */
  message: string;
}

const USER_REJECTION = [
  "user rejected",
  "user denied",
  "rejected the request",
  "request rejected",
  "transaction rejected",
  "user cancelled",
  "action_rejected",
];
const INSUFFICIENT_FUNDS = ["insufficient funds", "exceeds the balance", "exceeds balance"];

export function decodeSopaError(err: unknown): DecodedSopaError {
  const message = err instanceof Error ? err.message : String(err ?? "");
  const lower = message.toLowerCase();
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 4001 || USER_REJECTION.some((p) => lower.includes(p))) {
    return { key: "userRejected", message };
  }
  // Longest names first so "VotingEnded" never shadows a longer name containing it.
  const names = [...SOPA_ERROR_KEYS].sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (new RegExp(`\\b${name}\\b`).test(message)) return { key: name, message };
  }
  if (INSUFFICIENT_FUNDS.some((p) => lower.includes(p))) {
    return { key: "insufficientFunds", message };
  }
  return { key: null, message: message.split("\n")[0] || "Unknown error" };
}
