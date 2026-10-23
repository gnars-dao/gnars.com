"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, Loader2, Trophy, Vote } from "lucide-react";
import { useReadContract } from "wagmi";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { sopaCalls, usePoidhSopaWrite } from "@/hooks/use-poidh-sopa-write";
import { POIDH_SOPA } from "@/lib/config";
import { POIDH_SOPA_ABI } from "@/lib/poidh-sopa/abi";
import {
  equalSplitPercents,
  MAX_WINNERS,
  previewPayouts,
  validateWinnerShares,
} from "@/lib/poidh-sopa/shares";
import { findSopaToken, formatTokenAmount } from "@/lib/poidh-sopa/tokens";
import type { SopaBountyDetail } from "@/lib/poidh-sopa/types";
import { cn } from "@/lib/utils";

interface SopaWinnersPickerProps {
  bounty: SopaBountyDetail;
  onDone: () => void;
}

type Mode = "pay" | "vote";

/**
 * Issuer picks 1–10 claims and a % split. Solo bounties pay at once with `acceptClaims`.
 * Open bounties with outside contributors must go to a contributor vote
 * (`submitWinnersForVote`). Open bounties funded only by the issuer can do either: pay
 * now, or close to new claims behind a vote that passes on the issuer's weight alone.
 */
export function SopaWinnersPicker({ bounty, onDone }: SopaWinnersPickerProps) {
  const t = useTranslations("bounties");
  const write = usePoidhSopaWrite();
  const [selected, setSelected] = useState<number[]>([]);
  const [percents, setPercents] = useState<string[]>([]);

  const mustVote = Boolean(bounty.isOpenBounty && bounty.everHadExternalContributor);
  const canChoose = Boolean(bounty.isOpenBounty) && !mustVote;
  const [mode, setMode] = useState<Mode>("pay");
  const needsVote = mustVote || (canChoose && mode === "vote");

  const { data: votingPeriod } = useReadContract({
    address: POIDH_SOPA.address ?? undefined,
    abi: POIDH_SOPA_ABI,
    functionName: "votingPeriod",
    chainId: POIDH_SOPA.chainId,
    query: { enabled: !!POIDH_SOPA.address && Boolean(bounty.isOpenBounty) },
  });
  const voteHours = typeof votingPeriod === "bigint" ? String(votingPeriod / 3600n) : null;
  const candidates = bounty.claims.filter((c) => !c.accepted);
  const token = findSopaToken(bounty.token);
  const decimals = token?.decimals ?? 18;
  const symbol = token?.symbol ?? "?";

  const validation = useMemo(() => validateWinnerShares(selected, percents), [selected, percents]);
  const payouts = useMemo(
    () =>
      validation.ok
        ? previewPayouts(BigInt(bounty.amount), validation.sharesBps, [
            bounty.fees.poidhBps,
            bounty.fees.sopaBps,
          ])
        : [],
    [validation, bounty.amount, bounty.fees],
  );
  const feePercent = (bounty.fees.poidhBps + bounty.fees.sopaBps) / 100;

  const toggle = (claimId: number, checked: boolean) => {
    const next = checked ? [...selected, claimId] : selected.filter((id) => id !== claimId);
    setSelected(next);
    // Re-split equally on every change; the issuer then adjusts by hand.
    setPercents(equalSplitPercents(next.length));
  };

  const setPercent = (i: number, value: string) =>
    setPercents((prev) => prev.map((p, j) => (j === i ? value.replace(/[^0-9.,]/g, "") : p)));

  const submit = async () => {
    if (!validation.ok) return;
    try {
      await write.run({
        build: needsVote
          ? sopaCalls.submitWinnersForVote(bounty.id, selected, validation.sharesBps)
          : sopaCalls.acceptClaims(bounty.id, selected, validation.sharesBps),
      });
      setSelected([]);
      setPercents([]);
      onDone();
    } catch {
      // shown inline
    }
  };

  if (candidates.length === 0) return null;

  const errorText =
    validation.error && selected.length > 0 ? t(`sopa.winners.errors.${validation.error}`) : null;

  return (
    <Card className="border-primary/30">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Trophy className="w-4 h-4 text-primary" />
          {t("sopa.winners.title")}
        </CardTitle>
        {!canChoose && (
          <CardDescription>
            {mustVote ? t("sopa.winners.voteDescription") : t("sopa.winners.payDescription")}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {canChoose && (
          <div className="space-y-2">
            <div
              role="group"
              aria-label={t("sopa.winners.modeLabel")}
              className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1"
            >
              {(["pay", "vote"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={mode === m}
                  disabled={write.isPending}
                  onClick={() => setMode(m)}
                  className={cn(
                    "flex items-center justify-center gap-1.5 rounded px-2 py-1.5 text-sm font-medium transition-colors cursor-pointer disabled:cursor-not-allowed",
                    mode === m
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {m === "pay" ? (
                    <Trophy className="w-3.5 h-3.5" />
                  ) : (
                    <Vote className="w-3.5 h-3.5" />
                  )}
                  {m === "pay" ? t("sopa.winners.modePay") : t("sopa.winners.modeVote")}
                </button>
              ))}
            </div>
            <p className="text-sm text-muted-foreground">
              {mode === "pay"
                ? t("sopa.winners.payDescription")
                : voteHours
                  ? t("sopa.winners.closeForVoteDescription", { hours: voteHours })
                  : t("sopa.winners.closeForVoteDescriptionNoPeriod")}
            </p>
          </div>
        )}
        <ul className="space-y-2">
          {candidates.map((claim) => {
            const idx = selected.indexOf(claim.id);
            const isSelected = idx >= 0;
            const disabled = !isSelected && selected.length >= MAX_WINNERS;
            return (
              <li
                key={claim.id}
                className={cn(
                  "flex items-center gap-3 rounded-md border px-3 py-2",
                  isSelected ? "border-primary/50 bg-primary/5" : "border-border",
                )}
              >
                <Checkbox
                  id={`winner-${claim.id}`}
                  checked={isSelected}
                  disabled={disabled || write.isPending}
                  onCheckedChange={(v) => toggle(claim.id, v === true)}
                />
                <label
                  htmlFor={`winner-${claim.id}`}
                  className="flex-1 min-w-0 cursor-pointer text-sm"
                >
                  <span className="font-medium truncate block">
                    #{claim.id} · {claim.name || t("sopa.claimFallback", { id: claim.id })}
                  </span>
                  <span className="text-xs text-muted-foreground font-mono">
                    {claim.issuer.slice(0, 6)}…{claim.issuer.slice(-4)}
                  </span>
                </label>
                {isSelected && (
                  <div className="flex items-center gap-1 shrink-0">
                    <Input
                      inputMode="decimal"
                      value={percents[idx] ?? ""}
                      onChange={(e) => setPercent(idx, e.target.value)}
                      className="h-8 w-20 text-right tabular-nums"
                      aria-label={t("sopa.winners.shareLabel", { id: claim.id })}
                      disabled={write.isPending}
                    />
                    <span className="text-sm text-muted-foreground">%</span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        {selected.length > 0 && (
          <div className="space-y-2 rounded-md bg-muted/40 px-3 py-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">
                {t("sopa.winners.selected", { count: selected.length, max: MAX_WINNERS })}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 cursor-pointer"
                onClick={() => setPercents(equalSplitPercents(selected.length))}
                disabled={write.isPending}
              >
                {t("sopa.winners.equalSplit")}
              </Button>
            </div>
            <div
              className={cn(
                "flex justify-between font-medium tabular-nums",
                validation.ok ? "text-emerald-500" : "text-destructive",
              )}
              aria-live="polite"
            >
              <span>{t("sopa.winners.total")}</span>
              <span>{Math.round(validation.totalPercent * 100) / 100}%</span>
            </div>
            {errorText && <p className="text-xs text-destructive">{errorText}</p>}
            {validation.ok && (
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                {selected.map((id, i) => (
                  <li key={id} className="flex justify-between tabular-nums">
                    <span>#{id}</span>
                    <span>
                      {formatTokenAmount(payouts[i] ?? 0n, decimals, decimals <= 6 ? 2 : 6)}{" "}
                      {symbol}
                    </span>
                  </li>
                ))}
                <li className="pt-1">{t("sopa.winners.feeNote", { fee: String(feePercent) })}</li>
              </ul>
            )}
          </div>
        )}

        {write.error && (
          <div className="flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              {write.error.key ? t(`sopa.errors.${write.error.key}`) : write.error.message}
            </span>
          </div>
        )}

        <Button
          className="w-full cursor-pointer"
          disabled={!validation.ok || write.isPending}
          onClick={submit}
        >
          {write.isPending ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              {write.phase === "confirming"
                ? t("sopa.create.waitingConfirmation")
                : t("sopa.create.confirmInWallet")}
            </>
          ) : needsVote ? (
            t("sopa.winners.submitForVote")
          ) : (
            t("sopa.winners.pay", { count: selected.length || 1 })
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
