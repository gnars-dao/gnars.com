"use client";

import { useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import { BountyCardFan, type FanCard, type Rarity } from "@/components/bounties/BountyCardFan";
import { formatEthToUsd, useEthPrice } from "@/hooks/use-eth-price";
import { usePoidhSopaBounties } from "@/hooks/use-poidh-sopa-bounties";
import { usePoidhBounties, type PoidhBountiesResponse } from "@/hooks/usePoidhBounties";
import { Link } from "@/i18n/navigation";
import { isPoidhSopaEnabled } from "@/lib/config";
import { toIntlLocale } from "@/lib/i18n/format";
import { isSopaCategory } from "@/lib/poidh-sopa/categories";
import { formatTokenAmount } from "@/lib/poidh-sopa/tokens";
import type { SopaBountiesResult } from "@/lib/poidh-sopa/types";
import { CHAIN_NAMES } from "@/lib/poidh/config";
import {
  DISCIPLINE_CODE,
  entryUsd,
  handTotals,
  rankHand,
  selectShowcaseBounties,
  selectSopaShowcase,
  sopaCode,
} from "./bounty-hand";
import { SectionHeading, SHELL, StatTile } from "./primitives";

/** How many cards the hand holds. Six is the widest fan that still reads at 1152px. */
const HAND_SIZE = 6;

/** Rarity by rank within the hand: the headline bounty (see `rankHand`) is the Legendary. */
const RANK_RARITY: Rarity[] = ["legendary", "epic", "rare", "rare", "uncommon", "common"];

/** poidh's own route for a bounty — where a claim is actually submitted. */
const POIDH_CHAIN_SLUG: Record<number, string> = { 8453: "base", 42161: "arbitrum" };

/** The card back shows prose, so the markdown thumbnail is pulled back out. */
function stripMarkdownImages(text: string): string {
  return (
    text
      .replace(/!\[.*?\]\(.*?\)/g, "")
      // An image whose `!` was dropped still renders as a bare link to the file.
      .replace(/\[\]\(.*?\)/g, "")
      .replace(/Thumbnail:\s*/gi, "")
      .trim()
  );
}

export function BountiesSection({
  /**
   * The server already fetched this for the ticker totals — handing it over as
   * react-query's initial data means the hand is dealt in the server HTML
   * instead of popping in after hydration.
   */
  initialBounties,
  initialSopa,
  initialUnavailable = false,
}: {
  initialBounties?: PoidhBountiesResponse;
  initialSopa?: SopaBountiesResult;
  initialUnavailable?: boolean;
}) {
  const t = useTranslations("newhome.bounties");
  const tb = useTranslations("bounties");
  const status = useTranslations("newhome");
  const locale = useLocale();
  const intlLocale = toIntlLocale(locale);
  const { ethPrice } = useEthPrice();
  const { data, isLoading, isError } = usePoidhBounties({
    status: "open",
    limit: 100,
    filterGnarly: true,
    initialData: initialBounties,
  });
  const sopaQuery = usePoidhSopaBounties(initialSopa);
  const sopaData = sopaQuery.data;

  // Each source fails on its own: one being down must not hide the other's cards.
  const poidhFailed = !data && (isError || initialUnavailable);
  const sopaFailed = isPoidhSopaEnabled() && !sopaData && sopaQuery.isError;
  const sopaReady = !isPoidhSopaEnabled() || Boolean(sopaData);
  // The tiles are totals: with a source missing they would understate, so they
  // read as unavailable rather than as a smaller number.
  const totalsReady = Boolean(data) && sopaReady;
  const totalsFailed = poidhFailed || sopaFailed;
  const pendingValue = totalsFailed ? status("dataUnavailable") : "…";

  const { hand, count, eth, stableUsd } = useMemo(() => {
    const ranked = rankHand(
      selectSopaShowcase(sopaData?.bounties ?? []),
      selectShowcaseBounties(data?.bounties ?? []),
      ethPrice,
    );
    const total = ranked.length;

    const serialOf = (rank: number) =>
      `${String(rank + 1).padStart(3, "0")} / ${String(total).padStart(3, "0")}`;
    const ageOf = (createdAt: number) => {
      // eslint-disable-next-line react-hooks/purity -- intentional render-time clock read for the "Xd" age label
      const daysAgo = Math.max(0, Math.floor((Date.now() - createdAt * 1000) / 86_400_000));
      return daysAgo === 0 ? tb("card.today") : `${daysAgo}d`;
    };
    const usdOf = (value: number | null) =>
      value === null ? "—" : formatEthToUsd(value, 1, intlLocale);

    const cards: FanCard[] = ranked.slice(0, HAND_SIZE).map((entry, rank) => {
      const usd = usdOf(entryUsd(entry, ethPrice));

      if (entry.kind === "sopa") {
        const { bounty: b, token, team } = entry.sopa;
        const decimals = token?.decimals ?? 18;
        const href = `/community/bounties/sopa/${b.id}`;
        return {
          id: `sopa-${b.id}`,
          href,
          poidhUrl: href,
          source: "sopa" as const,
          featured: team,
          code: sopaCode(b),
          category: isSopaCategory(b.category)
            ? tb(`sopa.categories.${b.category}`)
            : (b.category ?? ""),
          title: b.title,
          description: stripMarkdownImages(b.description),
          eth: formatTokenAmount(b.amount, decimals, decimals <= 6 ? 2 : 4),
          symbol: token?.symbol ?? "?",
          usd,
          age: ageOf(b.createdAt),
          chain: CHAIN_NAMES[8453],
          status: tb("status.open"),
          statusTone: "open" as const,
          serial: serialOf(rank),
          rarity: RANK_RARITY[rank] ?? "common",
        };
      }

      const { bounty: b, discipline, eth } = entry.item;
      const statusTone = b.isCanceled
        ? ("closed" as const)
        : b.isVoting
          ? ("voting" as const)
          : b.isCompleted
            ? ("closed" as const)
            : ("open" as const);

      const slug = POIDH_CHAIN_SLUG[b.chainId] ?? "base";

      return {
        id: `${b.chainId}-${b.id}`,
        href: `/community/bounties/${b.chainId}/${b.id}`,
        poidhUrl: `https://poidh.xyz/${slug}/bounty/${b.id}`,
        // The bounty's own poidh number, not its reward: Gnars bounties are
        // small enough that hundredths-of-an-ETH collapsed several cards onto
        // the same code, and the legend printed `SURF-01` twice.
        code: `${DISCIPLINE_CODE[discipline]}-${String(b.id).padStart(2, "0")}`,
        category: t(`discipline.${discipline}`),
        title: b.title || b.name,
        description: stripMarkdownImages(b.description),
        eth: eth.toFixed(4),
        usd,
        age: ageOf(b.createdAt),
        chain: CHAIN_NAMES[b.chainId as keyof typeof CHAIN_NAMES] ?? "—",
        status: tb(`status.${statusTone}`),
        statusTone,
        serial: serialOf(rank),
        rarity: RANK_RARITY[rank] ?? "common",
      };
    });

    return { hand: cards, count: total, ...handTotals(ranked) };
  }, [data, sopaData, ethPrice, intlLocale, t, tb]);

  // ETH needs a price; USDC is already dollars. Unknown only when ETH is in the
  // pool and there is no price to convert it with.
  const usdTotal =
    eth > 0 && !(ethPrice > 0) ? null : (ethPrice > 0 ? eth * ethPrice : 0) + stableUsd;
  const bothFailed = poidhFailed && (sopaFailed || !isPoidhSopaEnabled());

  return (
    <section id="bounties" className="px-4 py-10 sm:px-6 sm:py-18">
      <div className={`${SHELL} flex flex-col gap-6 px-0`}>
        <SectionHeading
          eyebrow={
            <>
              {t("eyebrow")} · <span className="text-[#4ade80]">poidh</span>
            </>
          }
          title={t("title")}
          body={t("body")}
          aside={
            <>
              <StatTile
                value={totalsReady ? `${eth.toFixed(2)} ETH` : pendingValue}
                label={t("stats.pool")}
              />
              <StatTile value={totalsReady ? count : pendingValue} label={t("stats.open")} />
              <StatTile
                value={
                  !totalsReady
                    ? pendingValue
                    : usdTotal === null
                      ? status("dataUnavailable")
                      : formatEthToUsd(usdTotal, 1, intlLocale)
                }
                label={t("stats.usd")}
              />
            </>
          }
        />

        {bothFailed ? (
          <p role="status" className="py-8 text-sm text-muted-foreground">
            {status("gov.loadFailed")}
          </p>
        ) : (isLoading || sopaQuery.isLoading) && hand.length === 0 ? (
          <div className="flex h-[420px] items-center justify-center rounded-[22px] border border-border bg-muted/30 font-mono text-sm text-muted-foreground/70">
            …
          </div>
        ) : (
          <>
            {(poidhFailed || sopaFailed) && (
              <p role="status" className="text-sm text-muted-foreground">
                {t(poidhFailed ? "partial.poidh" : "partial.sopa")}
              </p>
            )}
            <BountyCardFan cards={hand} />
          </>
        )}

        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card px-6 py-5">
          <p className="text-pretty text-[14.5px] text-muted-foreground">
            {t("flowPrefix")} <span className="font-semibold text-foreground">{t("flow")}</span>
          </p>
          <div className="flex gap-2">
            <Link
              href="/community/bounties"
              className="rounded-lg bg-foreground px-4.5 py-2.5 text-sm font-semibold text-background hover:opacity-90"
            >
              {t("create")}
            </Link>
            <a
              href="https://poidh.xyz"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg border border-border bg-muted/40 px-4.5 py-2.5 text-sm font-medium text-foreground hover:bg-accent"
            >
              {t("viewPoidh")}
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
