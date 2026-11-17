"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { ExternalLink, Trophy } from "lucide-react";
import { AddressDisplay } from "@/components/ui/address-display";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import { summarizeHistory } from "@/lib/poidh-sopa/history";
import { bpsToPercentString } from "@/lib/poidh-sopa/shares";
import { findSopaToken, formatTokenAmount } from "@/lib/poidh-sopa/tokens";
import type { SopaHistoryEntry, SopaHistoryResult } from "@/lib/poidh-sopa/types";
import { SopaCategoryChip, SopaSourceBadge } from "./SopaBountyCard";

const PAGE_SIZE = 6;

function formatRaw(raw: bigint | string, tokenAddress: string): string {
  const token = findSopaToken(tokenAddress);
  return `${formatTokenAmount(raw, token?.decimals ?? 18, 4)} ${token?.symbol ?? "?"}`;
}

/**
 * Results: finished Sopa bounties, who won and what they were paid, all read from the
 * contract. Each winner links to their member page, their claim on the bounty page,
 * and the claim NFT that proves it onchain.
 */
export function SopaBountyHistory({ history }: { history: SopaHistoryResult }) {
  const t = useTranslations("bounties");
  const [visible, setVisible] = useState(PAGE_SIZE);
  const summary = useMemo(() => summarizeHistory(history.entries), [history.entries]);

  if (!history.error && history.entries.length === 0) return null;

  const paid = [...summary.paidByToken].map(([token, raw]) => formatRaw(raw, token));

  return (
    <section className="space-y-4" aria-labelledby="bounty-results">
      <div className="space-y-1">
        <h2 id="bounty-results" className="text-lg font-semibold tracking-tight">
          {t("history.title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("history.description")}</p>
      </div>

      {history.error ? (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {t("history.error")}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border bg-card p-5 sm:grid-cols-3">
            <div className="col-span-2 sm:col-span-1">
              <div className="text-2xl font-bold tabular-nums tracking-tight">
                {paid.length > 0 ? paid.join(" + ") : "—"}
              </div>
              <div className="text-xs text-muted-foreground">
                {summary.incomplete ? t("history.paidPartial") : t("history.paid")}
              </div>
            </div>
            <div>
              <div className="text-2xl font-bold tabular-nums">{summary.finished}</div>
              <div className="text-xs text-muted-foreground">{t("history.finished")}</div>
            </div>
            <div>
              <div className="text-2xl font-bold tabular-nums">{summary.winners}</div>
              <div className="text-xs text-muted-foreground">{t("history.winners")}</div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {history.entries.slice(0, visible).map((entry) => (
              <HistoryCard key={entry.bounty.id} entry={entry} claimNft={history.claimNft} />
            ))}
          </div>
          {history.entries.length > visible && (
            <Button
              variant="outline"
              className="h-11 w-full sm:mx-auto sm:flex sm:w-auto sm:px-8"
              onClick={() => setVisible((v) => v + PAGE_SIZE)}
            >
              {t("grid.showMore", { count: history.entries.length - visible })}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

function HistoryCard({
  entry: { bounty, winners },
  claimNft,
}: {
  entry: SopaHistoryEntry;
  claimNft: `0x${string}` | null;
}) {
  const t = useTranslations("bounties");
  const href = `/community/bounties/sopa/${bounty.id}`;

  return (
    <Card className="gap-0 py-0">
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-1.5">
          <SopaSourceBadge issuer={bounty.issuer} />
          <SopaCategoryChip category={bounty.category} />
        </div>
        <Link
          href={href}
          className="block font-bold leading-snug hover:text-primary transition-colors"
        >
          {bounty.title}
        </Link>

        {winners.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("history.winnersUnavailable")}</p>
        ) : (
          <ul className="space-y-3">
            {winners.map((w) => (
              <li
                key={w.claimId}
                className="space-y-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <Link
                    href={`${href}#claim-${w.claimId}`}
                    className="min-w-0 text-sm font-medium break-words hover:text-primary hover:underline underline-offset-4"
                  >
                    <Trophy className="mr-1.5 inline h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                    {w.name || t("sopa.claimFallback", { id: w.claimId })}
                  </Link>
                  <span className="shrink-0 text-right text-sm font-semibold tabular-nums">
                    {formatRaw(w.amount, bounty.token)}
                    {winners.length > 1 && (
                      <span className="block text-xs font-normal text-muted-foreground">
                        {bpsToPercentString(w.shareBps)}%
                      </span>
                    )}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <AddressDisplay
                    address={w.claimer}
                    variant="compact"
                    showCopy={false}
                    showExplorer={false}
                    avatarSize="xs"
                  />
                  {claimNft && (
                    <a
                      href={`https://basescan.org/nft/${claimNft}/${w.claimId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      {t("history.proof")}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
