"use client";

import { useLocale, useTranslations } from "next-intl";
import { formatEther } from "viem";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { formatEthToUsd, useEthPrice } from "@/hooks/use-eth-price";
import { Link } from "@/i18n/navigation";
import { toIntlLocale } from "@/lib/i18n/format";
import { displayAmount } from "@/lib/poidh-sopa/bounty-data";
import { isSopaCategory } from "@/lib/poidh-sopa/categories";
import { findSopaToken, formatSopaReward, isEthToken } from "@/lib/poidh-sopa/tokens";
import type { SopaBounty, SopaStatus } from "@/lib/poidh-sopa/types";

export const SOPA_STATUS_STYLES: Record<SopaStatus, string> = {
  cancelled: "bg-red-500/10 text-red-400 border-red-500/20",
  voting: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  open: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  paid: "bg-muted text-muted-foreground border-border",
};

function stripMarkdown(text: string): string {
  return text
    .replace(/!\[.*?\]\(.*?\)/g, "")
    .replace(/[#*_`>]/g, "")
    .trim();
}

/** Source badge shared by the card and the detail page. */
export function SopaSourceBadge() {
  const t = useTranslations("bounties");
  return (
    <Badge className="bg-primary text-primary-foreground border-transparent">
      {t("sopa.sourceBadge")}
    </Badge>
  );
}

export function SopaCategoryChip({ category }: { category: string | null }) {
  const t = useTranslations("bounties");
  if (!category) return null;
  return (
    <Badge variant="outline" className="capitalize">
      {isSopaCategory(category) ? t(`sopa.categories.${category}`) : category}
    </Badge>
  );
}

export function SopaStatusBadge({ status }: { status: SopaStatus }) {
  const t = useTranslations("bounties");
  return (
    <Badge variant="outline" className={SOPA_STATUS_STYLES[status]}>
      {t(`sopa.status.${status}`)}
    </Badge>
  );
}

export function SopaBountyCard({ bounty }: { bounty: SopaBounty }) {
  const t = useTranslations("bounties");
  const locale = useLocale();
  const { ethPrice } = useEthPrice();
  const token = findSopaToken(bounty.token);
  const amount = displayAmount(bounty);
  const isEth = isEthToken(bounty.token);
  const usd =
    isEth && ethPrice > 0
      ? formatEthToUsd(parseFloat(formatEther(BigInt(amount))), ethPrice, toIntlLocale(locale))
      : null;
  // eslint-disable-next-line react-hooks/purity -- intentional render-time clock read for "Xd ago" label
  const daysAgo = Math.floor((Date.now() - bounty.createdAt * 1000) / 86_400_000);
  const timeLabel =
    daysAgo <= 0
      ? t("card.today")
      : daysAgo === 1
        ? t("card.oneDayAgo")
        : t("card.daysAgo", { count: daysAgo });

  return (
    <Card className="group hover:border-primary/50 overflow-hidden py-0 border-primary/30">
      <CardContent className="flex flex-col flex-1 px-5 pt-5 pb-0 gap-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
            <SopaSourceBadge />
            <SopaCategoryChip category={bounty.category} />
          </div>
          <SopaStatusBadge status={bounty.status} />
        </div>

        <h3 className="font-bold text-base leading-snug line-clamp-2 group-hover:text-primary transition-colors duration-150">
          {bounty.title}
        </h3>

        <p className="text-sm text-muted-foreground line-clamp-2 leading-relaxed flex-1">
          {stripMarkdown(bounty.description)}
        </p>

        <div className="rounded-lg bg-muted/40 px-4 py-3 border border-border/50">
          <span className="text-xs text-muted-foreground uppercase tracking-wide font-medium">
            {t("card.reward")}
          </span>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-2xl font-bold text-primary">
              {formatSopaReward(amount, bounty.token).split(" ")[0]}
            </span>
            <Badge variant="secondary" className="font-semibold">
              {token?.symbol ?? "?"}
            </Badge>
            {usd && (
              <span className="ml-auto text-sm font-medium text-emerald-600 dark:text-emerald-400">
                {usd}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{timeLabel}</span>
          {bounty.isOpenBounty !== null && (
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground/40">·</span>
              <span>{bounty.isOpenBounty ? t("sopa.type.open") : t("sopa.type.solo")}</span>
            </div>
          )}
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground/40">·</span>
            <span>Base</span>
          </div>
        </div>
      </CardContent>

      <CardFooter className="px-5 pb-5 pt-4">
        <Link href={`/community/bounties/sopa/${bounty.id}`} className="block w-full">
          <Button className="w-full text-sm font-semibold">{t("cta.view")}</Button>
        </Link>
      </CardFooter>
    </Card>
  );
}
