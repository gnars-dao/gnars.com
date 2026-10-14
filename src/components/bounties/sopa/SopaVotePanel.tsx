"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { sopaCalls, usePoidhSopaWrite } from "@/hooks/use-poidh-sopa-write";
import { bpsToPercentString } from "@/lib/poidh-sopa/shares";
import { findSopaToken, formatTokenAmount } from "@/lib/poidh-sopa/tokens";
import type { SopaBountyDetail } from "@/lib/poidh-sopa/types";

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function formatRemaining(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${Math.max(m, 1)}m`;
}

interface SopaVotePanelProps {
  bounty: SopaBountyDetail;
  /** Connected reader address (view-mode aware). */
  address: string | undefined;
  onDone: () => void;
}

/** Active winners proposal on an open bounty: split, weighted tally, vote / resolve / reset. */
export function SopaVotePanel({ bounty, address, onDone }: SopaVotePanelProps) {
  const t = useTranslations("bounties");
  const now = useNow();
  const voteYes = usePoidhSopaWrite();
  const voteNo = usePoidhSopaWrite();
  const resolve = usePoidhSopaWrite();
  const resetVote = usePoidhSopaWrite();
  // Covers the gap until the refetched detail includes this vote's VoteCast log. Keyed
  // by the round's deadline so a new round (after a failed vote) can be voted again.
  const [votedDeadline, setVotedDeadline] = useState<number | null>(null);

  if (!bounty.votes || bounty.proposal.length === 0) return null;

  const token = findSopaToken(bounty.token);
  const decimals = token?.decimals ?? 18;
  const symbol = token?.symbol ?? "?";
  const yes = BigInt(bounty.votes.yes);
  const no = BigInt(bounty.votes.no);
  const total = yes + no;
  const yesPct = total > 0n ? Number((yes * 100n) / total) : 50;
  const ended = now >= bounty.votes.deadline;
  // PoidhSopa: passes when yes > (yes + no) / 2.
  const wouldPass = yes > total / 2n;

  const lower = address?.toLowerCase();
  const isIssuer = lower === bounty.issuer.toLowerCase();
  const isParticipant = Boolean(
    lower && bounty.participants.some((p) => p.address.toLowerCase() === lower),
  );
  const hasVoted =
    votedDeadline === bounty.votes.deadline || Boolean(lower && bounty.voters?.includes(lower));
  const canVote = !ended && isParticipant && !isIssuer && !hasVoted;
  const claimName = (id: number) =>
    bounty.claims.find((c) => c.id === id)?.name || t("sopa.claimFallback", { id });

  const act = async (
    w: ReturnType<typeof usePoidhSopaWrite>,
    build: Parameters<typeof w.run>[0]["build"],
    isVote = false,
  ) => {
    try {
      await w.run({ build });
      if (isVote && bounty.votes) setVotedDeadline(bounty.votes.deadline);
      onDone();
    } catch {
      // shown inline
    }
  };

  const errors = [voteYes, voteNo, resolve, resetVote]
    .map((w) => w.error)
    .filter((e): e is NonNullable<typeof e> => e !== null);
  const anyPending = [voteYes, voteNo, resolve, resetVote].some((w) => w.isPending);
  const spinner = <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />;

  return (
    <Card className="border-yellow-500/20 bg-yellow-500/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-base text-yellow-400">{t("sopa.vote.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1.5">
            {t("sopa.vote.proposedWinners")}
          </p>
          <ul className="space-y-1 text-sm">
            {bounty.proposal.map((s) => (
              <li key={s.claimId} className="flex justify-between gap-2">
                <span className="truncate">
                  #{s.claimId} · {claimName(s.claimId)}
                </span>
                <span className="tabular-nums font-semibold">
                  {bpsToPercentString(s.shareBps)}%
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-1.5">
          <div className="flex justify-between text-xs font-medium tabular-nums">
            <span className="text-emerald-400">
              {t("sopa.vote.yes", { amount: formatTokenAmount(yes, decimals), token: symbol })}
            </span>
            <span className="text-red-400">
              {t("sopa.vote.no", { amount: formatTokenAmount(no, decimals), token: symbol })}
            </span>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all duration-500"
              style={{ width: `${yesPct}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {t("sopa.vote.weightedNote", { token: symbol })}
          </p>
        </div>

        <div className="flex items-center gap-1.5 text-xs text-muted-foreground border-t border-border/50 pt-2">
          <Clock className="w-3 h-3 shrink-0" />
          <span>
            {ended
              ? t("voteDashboard.votePeriodEnded")
              : t("voteDashboard.voteClosesIn", {
                  deadline: formatRemaining(bounty.votes.deadline - now),
                })}
          </span>
        </div>

        {canVote && (
          <div className="grid grid-cols-2 gap-2">
            <Button
              size="sm"
              className="cursor-pointer bg-emerald-600 hover:bg-emerald-700 text-white"
              disabled={anyPending}
              onClick={() => act(voteYes, sopaCalls.vote(bounty.id, true), true)}
            >
              {voteYes.isPending ? spinner : <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />}
              {t("detail.voteYes")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="cursor-pointer border-red-500/40 text-red-400 hover:bg-red-500/10"
              disabled={anyPending}
              onClick={() => act(voteNo, sopaCalls.vote(bounty.id, false), true)}
            >
              {voteNo.isPending ? spinner : <XCircle className="w-3.5 h-3.5 mr-1.5" />}
              {t("detail.voteNo")}
            </Button>
          </div>
        )}
        {!ended && hasVoted && !isIssuer && (
          <p className="text-xs text-muted-foreground">{t("sopa.vote.alreadyVoted")}</p>
        )}
        {!ended && isIssuer && (
          <p className="text-xs text-muted-foreground">{t("sopa.vote.issuerAutoYes")}</p>
        )}

        {ended && (
          <div className="space-y-2">
            <Button
              size="sm"
              className="w-full cursor-pointer"
              disabled={anyPending}
              onClick={() => act(resolve, sopaCalls.resolveVote(bounty.id))}
            >
              {resolve.isPending && spinner}
              {wouldPass ? t("sopa.vote.resolvePay") : t("detail.resolveVote")}
            </Button>
            {!wouldPass && (
              <Button
                size="sm"
                variant="outline"
                className="w-full cursor-pointer"
                disabled={anyPending}
                onClick={() => act(resetVote, sopaCalls.resetVotingPeriod(bounty.id))}
              >
                {resetVote.isPending && spinner}
                {t("sopa.vote.reset")}
              </Button>
            )}
          </div>
        )}

        {errors.map((e, i) => (
          <div
            key={i}
            className="flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-xs text-destructive"
          >
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{e.key ? t(`sopa.errors.${e.key}`) : e.message}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
