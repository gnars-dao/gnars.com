"use client";

import { useCallback, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Settings2,
  Trophy,
  Users,
} from "lucide-react";
import { formatEther } from "viem";
import { useReadContract } from "wagmi";
import { ClaimBountyModal } from "@/components/bounties/ClaimBountyModal";
import { MediaEmbed } from "@/components/bounties/MediaEmbed";
import { Markdown } from "@/components/common/Markdown";
import { AddressDisplay } from "@/components/ui/address-display";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatEthToUsd, useEthPrice } from "@/hooks/use-eth-price";
import {
  sopaBountiesKey,
  sopaBountyKey,
  usePoidhSopaBounty,
} from "@/hooks/use-poidh-sopa-bounties";
import { sopaCalls, usePoidhSopaWrite } from "@/hooks/use-poidh-sopa-write";
import { Link } from "@/i18n/navigation";
import { POIDH_SOPA } from "@/lib/config";
import { toIntlLocale } from "@/lib/i18n/format";
import { POIDH_SOPA_ABI } from "@/lib/poidh-sopa/abi";
import { displayAmount } from "@/lib/poidh-sopa/bounty-data";
import { bpsToPercentString } from "@/lib/poidh-sopa/shares";
import {
  findSopaToken,
  formatTokenAmount,
  isEthToken,
  parseTokenAmountInput,
} from "@/lib/poidh-sopa/tokens";
import type { SopaBountyDetail } from "@/lib/poidh-sopa/types";
import { getExplorerUrl, getTxUrl } from "@/lib/poidh/config";
import { SopaCategoryChip, SopaSourceBadge, SopaStatusBadge } from "./SopaBountyCard";
import { SopaVotePanel } from "./SopaVotePanel";
import { SopaWinnersPicker } from "./SopaWinnersPicker";
import { SopaWithdrawalBanner } from "./SopaWithdrawalBanner";
import { useSopaWallet } from "./use-sopa-wallet";

/** What the bounty is worth: live escrow, or what was paid / committed once it closed. */
function rewardAmount(b: SopaBountyDetail): bigint {
  if (b.status === "open" || b.status === "voting") return BigInt(b.amount);
  return BigInt(displayAmount(b));
}

function WriteError({ error }: { error: ReturnType<typeof usePoidhSopaWrite>["error"] }) {
  const t = useTranslations("bounties");
  if (!error) return null;
  return (
    <div className="flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-xs text-destructive">
      <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <span>{error.key ? t(`sopa.errors.${error.key}`) : error.message}</span>
    </div>
  );
}

function PendingLabel({ w }: { w: ReturnType<typeof usePoidhSopaWrite> }) {
  const t = useTranslations("bounties");
  return (
    <>
      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
      {w.phase === "confirming"
        ? t("sopa.create.waitingConfirmation")
        : w.phase === "approving"
          ? t("sopa.create.approveInWallet")
          : t("sopa.create.confirmInWallet")}
      {w.step && ` (${w.step.current}/${w.step.total})`}
    </>
  );
}

interface SopaBountyDetailViewProps {
  initialBounty: SopaBountyDetail;
}

export function SopaBountyDetailView({ initialBounty }: SopaBountyDetailViewProps) {
  const t = useTranslations("bounties");
  const locale = useLocale();
  const queryClient = useQueryClient();
  const { ethPrice } = useEthPrice();
  const { address, isConnected, wrongNetwork, isSwitching, connect, switchToBase } =
    useSopaWallet();
  const { data } = usePoidhSopaBounty(initialBounty.id, initialBounty);
  const bounty = data ?? initialBounty;

  const join = usePoidhSopaWrite();
  const cancel = usePoidhSopaWrite();
  const withdrawOpen = usePoidhSopaWrite();
  const refund = usePoidhSopaWrite();
  const [joinAmount, setJoinAmount] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: sopaBountyKey(bounty.id) });
    void queryClient.invalidateQueries({ queryKey: sopaBountiesKey });
  }, [queryClient, bounty.id]);

  const token = findSopaToken(bounty.token);
  const decimals = token?.decimals ?? 18;
  const symbol = token?.symbol ?? "?";
  const isEth = isEthToken(bounty.token);
  const digits = decimals <= 6 ? 2 : 4;

  const { data: minContribution } = useReadContract({
    address: POIDH_SOPA.address ?? undefined,
    abi: POIDH_SOPA_ABI,
    functionName: "MIN_CONTRIBUTION",
    chainId: POIDH_SOPA.chainId,
    query: { enabled: !!POIDH_SOPA.address && isEth && !!bounty.isOpenBounty },
  });

  const reward = rewardAmount(bounty);
  const usd =
    isEth && ethPrice > 0
      ? formatEthToUsd(parseFloat(formatEther(reward)), ethPrice, toIntlLocale(locale))
      : null;

  const lower = address?.toLowerCase();
  const isIssuer = lower === bounty.issuer.toLowerCase();
  const myContribution = bounty.participants.find((p) => p.address.toLowerCase() === lower);
  const isActive = bounty.status === "open";
  const winners = new Map(bounty.winners.map((w) => [w.claimId, w.shareBps]));
  const feePercent = (bounty.fees.poidhBps + bounty.fees.sopaBps) / 100;

  const joinRaw = parseTokenAmountInput(joinAmount, decimals);
  const joinBelowMin =
    isEth && joinRaw !== null && typeof minContribution === "bigint" && joinRaw < minContribution;

  const run = async (
    w: ReturnType<typeof usePoidhSopaWrite>,
    plan: Parameters<typeof w.run>[0],
  ) => {
    try {
      await w.run(plan);
      refresh();
      return true;
    } catch {
      return false; // shown inline
    }
  };

  const connectGate = !isConnected ? (
    <Button className="w-full cursor-pointer" onClick={connect}>
      {t("sopa.create.connectWallet")}
    </Button>
  ) : wrongNetwork ? (
    <Button className="w-full cursor-pointer" onClick={switchToBase} disabled={isSwitching}>
      {isSwitching ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : (
        t("sopa.create.switchTo", { network: "Base" })
      )}
    </Button>
  ) : null;

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl">
      <Button asChild variant="ghost" size="sm" className="mb-6">
        <Link href="/community/bounties">
          <ArrowLeft className="w-4 h-4 mr-2" />
          {t("detail.backToBounties")}
        </Link>
      </Button>

      {/* Winners and refunded issuers withdraw here, not only from the list page */}
      {address && (
        <div className="mb-6 space-y-2 empty:hidden">
          <SopaWithdrawalBanner userAddress={address as `0x${string}`} />
        </div>
      )}

      {/* Header */}
      <div className="mb-8">
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <SopaSourceBadge />
          <Badge variant="outline">Base</Badge>
          <SopaStatusBadge status={bounty.status} />
          {bounty.isOpenBounty !== null && (
            <Badge variant="secondary">
              {bounty.isOpenBounty ? t("sopa.type.open") : t("sopa.type.solo")}
            </Badge>
          )}
          <SopaCategoryChip category={bounty.category} />
        </div>
        <h1 className="text-3xl md:text-4xl font-bold mb-4 leading-tight break-words">
          {bounty.title}
        </h1>
        <div className="flex flex-wrap items-baseline gap-3">
          <span className="text-4xl md:text-5xl font-bold tabular-nums">
            {formatTokenAmount(reward, decimals, digits)}
          </span>
          <span className="text-xl text-muted-foreground">{symbol}</span>
          {usd && (
            <span className="text-lg font-medium text-emerald-600 dark:text-emerald-400">
              {usd}
            </span>
          )}
        </div>
      </div>

      <div className="grid md:grid-cols-3 gap-6">
        {/* Main */}
        <div className="md:col-span-2 space-y-6 min-w-0">
          <Card>
            <CardHeader>
              <CardTitle>{t("detail.objective")}</CardTitle>
            </CardHeader>
            <CardContent>
              <Markdown>{bounty.description}</Markdown>
            </CardContent>
          </Card>

          {/* Manage (issuer): what to do next, and the way out */}
          {isIssuer && (isActive || bounty.status === "voting") && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Settings2 className="w-4 h-4" />
                  {t("sopa.manage.title")}
                </CardTitle>
                <CardDescription>
                  {bounty.status === "voting"
                    ? t("sopa.manage.votingLocked")
                    : bounty.claims.length === 0
                      ? t("sopa.manage.waitingClaims")
                      : bounty.isOpenBounty
                        ? t("sopa.manage.pickOrVote")
                        : t("sopa.manage.pick")}
                </CardDescription>
              </CardHeader>
              {isActive && (
                <CardContent className="space-y-2 border-t pt-4">
                  <div className="text-sm font-medium">{t("sopa.manage.endTitle")}</div>
                  <p className="text-xs text-muted-foreground">
                    {bounty.isOpenBounty
                      ? t("sopa.manage.endDescriptionOpen")
                      : t("sopa.manage.endDescriptionSolo")}
                  </p>
                  {connectGate ??
                    (confirmCancel ? (
                      <div className="grid grid-cols-2 gap-2">
                        <Button
                          variant="outline"
                          className="cursor-pointer"
                          onClick={() => setConfirmCancel(false)}
                          disabled={cancel.isPending}
                        >
                          {t("cta.keepIt")}
                        </Button>
                        <Button
                          variant="destructive"
                          className="cursor-pointer"
                          disabled={cancel.isPending}
                          onClick={() =>
                            run(cancel, {
                              build: sopaCalls.cancel(bounty.id, Boolean(bounty.isOpenBounty)),
                            })
                          }
                        >
                          {cancel.isPending ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            t("sopa.manage.endConfirm")
                          )}
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="outline"
                        className="w-full cursor-pointer border-destructive/40 text-destructive"
                        onClick={() => setConfirmCancel(true)}
                      >
                        {t("sopa.manage.endCta")}
                      </Button>
                    ))}
                  {cancel.hash && cancel.isSuccess && (
                    <a
                      href={getTxUrl(POIDH_SOPA.chainId, cancel.hash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-primary hover:underline"
                    >
                      {t("detail.viewTx")}
                    </a>
                  )}
                  <WriteError error={cancel.error} />
                </CardContent>
              )}
            </Card>
          )}

          {bounty.status === "voting" && (
            <SopaVotePanel bounty={bounty} address={address} onDone={refresh} />
          )}

          {isIssuer && isActive && bounty.claims.length > 0 && (
            <SopaWinnersPicker bounty={bounty} onDone={refresh} />
          )}

          {/* Claims */}
          <Card>
            <CardHeader>
              <CardTitle>
                {bounty.claims.length > 0
                  ? t("detail.submittedClaims", { count: bounty.claims.length })
                  : t("detail.noClaims")}
              </CardTitle>
              {bounty.claims.length === 0 && (
                <CardDescription>{t("detail.noClaimsDescription")}</CardDescription>
              )}
            </CardHeader>
            {bounty.claims.length > 0 && (
              <CardContent className="space-y-4">
                {[...bounty.claims].reverse().map((claim) => {
                  const share = winners.get(claim.id);
                  return (
                    <div
                      key={claim.id}
                      className={`rounded-lg border p-4 space-y-3 ${claim.accepted ? "border-emerald-500/40 bg-emerald-500/5" : "border-border"}`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold break-words">
                          #{claim.id} · {claim.name || t("sopa.claimFallback", { id: claim.id })}
                        </span>
                        {claim.accepted && (
                          <Badge className="bg-emerald-500/15 text-emerald-500 border-emerald-500/30">
                            <Trophy className="w-3 h-3 mr-1" />
                            {share !== undefined
                              ? t("sopa.winnerShare", { share: bpsToPercentString(share) })
                              : t("detail.claimAccepted")}
                          </Badge>
                        )}
                      </div>
                      {claim.uri && <MediaEmbed url={claim.uri} alt={claim.name} />}
                      {claim.description && (
                        <Markdown className="prose-sm">{claim.description}</Markdown>
                      )}
                      <AddressDisplay
                        address={claim.issuer}
                        variant="compact"
                        showCopy={false}
                        showExplorer={false}
                        avatarSize="xs"
                      />
                    </div>
                  );
                })}
              </CardContent>
            )}
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-6 min-w-0">
          {/* Submit proof */}
          {isActive && !isIssuer && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("detail.submitYourProof")}</CardTitle>
                <CardDescription>{t("detail.proofDescription")}</CardDescription>
              </CardHeader>
              <CardContent>
                <ClaimBountyModal
                  bounty={{ chainId: POIDH_SOPA.chainId, onChainId: bounty.id }}
                  source="sopa"
                  onSuccess={() => refresh()}
                >
                  <Button className="w-full cursor-pointer">{t("detail.submitYourProof")}</Button>
                </ClaimBountyModal>
              </CardContent>
            </Card>
          )}

          {/* Join (open bounties) */}
          {isActive && bounty.isOpenBounty && !isIssuer && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("detail.addToPrizePool")}</CardTitle>
                <CardDescription>{t("sopa.join.description", { token: symbol })}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {connectGate ?? (
                  <>
                    <div className="flex gap-2">
                      <Input
                        inputMode="decimal"
                        placeholder={isEth ? "0.001" : "10"}
                        value={joinAmount}
                        onChange={(e) => setJoinAmount(e.target.value)}
                        disabled={join.isPending}
                        aria-label={t("sopa.join.amountLabel", { token: symbol })}
                      />
                      <span className="self-center text-sm text-muted-foreground">{symbol}</span>
                    </div>
                    {joinBelowMin && typeof minContribution === "bigint" && (
                      <p className="text-xs text-destructive">
                        {t("sopa.join.minimum", {
                          amount: formatTokenAmount(minContribution, 18, 6),
                        })}
                      </p>
                    )}
                    {!isEth && (
                      <p className="text-xs text-muted-foreground">
                        {join.canBatch
                          ? t("sopa.create.erc20HintBatch")
                          : t("sopa.create.erc20Hint")}
                      </p>
                    )}
                    <Button
                      className="w-full cursor-pointer"
                      disabled={join.isPending || joinRaw === null || joinBelowMin}
                      onClick={() =>
                        joinRaw !== null &&
                        run(join, {
                          approve: isEth ? undefined : { token: bounty.token, amount: joinRaw },
                          build: sopaCalls.join(bounty.id, bounty.token, joinRaw),
                        }).then((ok) => ok && setJoinAmount(""))
                      }
                    >
                      {join.isPending ? (
                        <PendingLabel w={join} />
                      ) : (
                        t("sopa.join.cta", {
                          amount: joinRaw !== null ? formatTokenAmount(joinRaw, decimals, 6) : "0",
                          token: symbol,
                        })
                      )}
                    </Button>
                    {join.isSuccess && (
                      <p className="flex items-center gap-1 text-xs text-emerald-500">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        {t("detail.contributionConfirmed")}
                      </p>
                    )}
                    <WriteError error={join.error} />
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {/* Withdraw my contribution (active open bounty) */}
          {isActive && myContribution && !isIssuer && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("sopa.withdrawContribution.title")}</CardTitle>
                <CardDescription>
                  {t("sopa.withdrawContribution.description", {
                    amount: formatTokenAmount(myContribution.amount, decimals, digits),
                    token: symbol,
                  })}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {connectGate ?? (
                  <Button
                    variant="outline"
                    className="w-full cursor-pointer"
                    disabled={withdrawOpen.isPending}
                    onClick={() =>
                      run(withdrawOpen, { build: sopaCalls.withdrawFromOpen(bounty.id) })
                    }
                  >
                    {withdrawOpen.isPending ? (
                      <PendingLabel w={withdrawOpen} />
                    ) : (
                      t("cta.withdrawFunds")
                    )}
                  </Button>
                )}
                <WriteError error={withdrawOpen.error} />
              </CardContent>
            </Card>
          )}

          {/* Refund from a cancelled open bounty */}
          {bounty.status === "cancelled" && bounty.isOpenBounty && myContribution && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("detail.withdrawContribution")}</CardTitle>
                <CardDescription>{t("detail.withdrawDescription")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {connectGate ?? (
                  <Button
                    variant="outline"
                    className="w-full cursor-pointer"
                    disabled={refund.isPending}
                    onClick={() => run(refund, { build: sopaCalls.claimRefund(bounty.id) })}
                  >
                    {refund.isPending ? <PendingLabel w={refund} /> : t("cta.withdrawFunds")}
                  </Button>
                )}
                <WriteError error={refund.error} />
              </CardContent>
            </Card>
          )}

          {bounty.status === "cancelled" && (
            <p className="text-sm text-muted-foreground">{t("detail.canceledNotice")}</p>
          )}

          {/* Details */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("detail.bountyDetails")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">{t("detail.issuer")}</div>
                <AddressDisplay
                  address={bounty.issuer}
                  variant="compact"
                  showCopy={false}
                  showExplorer={false}
                  avatarSize="xs"
                />
              </div>
              <div>
                <div className="text-xs text-muted-foreground">{t("detail.created")}</div>
                <div>
                  {new Date(bounty.createdAt * 1000).toLocaleDateString(toIntlLocale(locale))}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">{t("sopa.detail.token")}</div>
                <div>{symbol}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">{t("sopa.detail.fee")}</div>
                <div>{t("sopa.detail.feeValue", { fee: String(feePercent) })}</div>
              </div>
              {POIDH_SOPA.address && (
                <a
                  href={getExplorerUrl(POIDH_SOPA.chainId, POIDH_SOPA.address)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  {t("sopa.detail.contract")} <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </CardContent>
          </Card>

          {/* Participants */}
          {bounty.isOpenBounty && bounty.participants.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Users className="w-4 h-4" />
                  {t("detail.contributors")}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {bounty.participants.map((p) => (
                  <div key={p.address} className="flex items-center justify-between gap-2 text-sm">
                    <AddressDisplay
                      address={p.address}
                      variant="compact"
                      showCopy={false}
                      showExplorer={false}
                      avatarSize="xs"
                    />
                    <span className="tabular-nums text-muted-foreground shrink-0">
                      {formatTokenAmount(p.amount, decimals, digits)} {symbol}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
