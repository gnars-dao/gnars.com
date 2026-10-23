"use client";

import { useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatUnits } from "viem";
import { BountyCardFan, type FanCard, type Rarity } from "@/components/bounties/BountyCardFan";
import { formatEthToUsd, useEthPrice } from "@/hooks/use-eth-price";
import { usePoidhSopaBounties } from "@/hooks/use-poidh-sopa-bounties";
import { usePoidhBounties, type PoidhBountiesResponse } from "@/hooks/usePoidhBounties";
import { Link } from "@/i18n/navigation";
import { toIntlLocale } from "@/lib/i18n/format";
import { isSopaCategory } from "@/lib/poidh-sopa/categories";
import { findSopaToken, formatTokenAmount, isEthToken } from "@/lib/poidh-sopa/tokens";
import type { SopaBountiesResult, SopaBounty } from "@/lib/poidh-sopa/types";
import { CHAIN_NAMES } from "@/lib/poidh/config";
import { DISCIPLINE_CODE, selectShowcaseBounties, showcasePool } from "./bounty-hand";
import { SectionHeading, SHELL, StatTile } from "./primitives";

type Ranked =
  | { kind: "poidh"; item: ReturnType<typeof selectShowcaseBounties>[number] }
  | { kind: "sopa"; bounty: SopaBounty };

/** How many cards the hand holds. Six is the widest fan that still reads at 1152px. */
const HAND_SIZE = 6;

/** Rarity by rank within the hand: the richest bounty is the Legendary. */
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

/**
 * Deal the hand centre-out so the Legendary sits in the middle: rank 1 takes the
 * centre slot, then 2, 3, 4… alternate right and left of it. Without this the
 * fan would run richest-to-poorest left-to-right and bury the headline bounty.
 */
function dealCenterOut<T>(ranked: T[]): T[] {
  const slots: T[] = new Array(ranked.length);
  const centre = Math.floor((ranked.length - 1) / 2);
  let right = centre;
  let left = centre;
  ranked.forEach((item, rank) => {
    if (rank === 0) {
      slots[centre] = item;
    } else if (rank % 2 === 1) {
      slots[++right] = item;
    } else {
      slots[--left] = item;
    }
  });
  return slots.filter(Boolean);
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
  const { ethPrice } = useEthPrice();
  const { data, isLoading, isError } = usePoidhBounties({
    status: "open",
    limit: 100,
    filterGnarly: true,
    initialData: initialBounties,
  });
  const { data: sopaData } = usePoidhSopaBounties(initialSopa);
  const unavailable = !data && (isError || initialUnavailable);
  const pendingValue = unavailable ? status("dataUnavailable") : "…";

  const bounties = useMemo(() => data?.bounties ?? [], [data]);
  const sopaOpen = useMemo(
    () =>
      (sopaData?.bounties ?? [])
        .filter((b) => b.status === "open")
        .sort((a, b) => b.createdAt - a.createdAt),
    [sopaData],
  );

  const { hand, pool, usdPool, showcaseCount } = useMemo(() => {
    const showcase = selectShowcaseBounties(bounties);
    // Bounties the DAO created on this site lead the hand, newest first, in any
    // category: they are the ones the community is actively running. poidh's
    // skate and surf bounties fill whatever slots are left.
    const ranked: Ranked[] = [
      ...sopaOpen.map((bounty) => ({ kind: "sopa" as const, bounty })),
      ...showcase.map((item) => ({ kind: "poidh" as const, item })),
    ];
    const count = ranked.length;

    // ETH pool counts ETH rewards only; USDC joins the USD total at face value.
    let sopaEth = 0;
    let sopaUsd = 0;
    for (const b of sopaOpen) {
      const token = findSopaToken(b.token);
      if (!token) continue;
      const value = Number(formatUnits(BigInt(b.amount), token.decimals));
      if (isEthToken(b.token)) sopaEth += value;
      else if (token.symbol === "USDC") sopaUsd += value;
    }
    const total = showcasePool(showcase) + sopaEth;

    const serialOf = (rank: number) =>
      `${String(rank + 1).padStart(3, "0")} / ${String(count).padStart(3, "0")}`;
    const ageOf = (createdAt: number) => {
      // eslint-disable-next-line react-hooks/purity -- intentional render-time clock read for the "Xd" age label
      const daysAgo = Math.max(0, Math.floor((Date.now() - createdAt * 1000) / 86_400_000));
      return daysAgo === 0 ? tb("card.today") : `${daysAgo}d`;
    };

    const cards: FanCard[] = ranked.slice(0, HAND_SIZE).map((entry, rank) => {
      if (entry.kind === "sopa") {
        const b = entry.bounty;
        const token = findSopaToken(b.token);
        const decimals = token?.decimals ?? 18;
        const amount = Number(formatUnits(BigInt(b.amount), decimals));
        const usdValue = isEthToken(b.token)
          ? formatEthToUsd(amount, ethPrice, toIntlLocale(locale))
          : token?.symbol === "USDC"
            ? formatEthToUsd(amount, 1, toIntlLocale(locale))
            : "—";
        const category = b.category ?? "";
        const code =
          category in DISCIPLINE_CODE
            ? DISCIPLINE_CODE[category as keyof typeof DISCIPLINE_CODE]
            : (category || "gnars").toUpperCase().slice(0, 5);
        const href = `/community/bounties/sopa/${b.id}`;
        return {
          id: `sopa-${b.id}`,
          href,
          poidhUrl: href,
          source: "sopa" as const,
          code: `${code}-${String(b.id).padStart(2, "0")}`,
          category: isSopaCategory(category) ? tb(`sopa.categories.${category}`) : category,
          title: b.title,
          description: stripMarkdownImages(b.description),
          eth: formatTokenAmount(b.amount, decimals, decimals <= 6 ? 2 : 4),
          symbol: token?.symbol ?? "?",
          usd: usdValue,
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
        usd: formatEthToUsd(eth, ethPrice, toIntlLocale(locale)),
        age: ageOf(b.createdAt),
        chain: CHAIN_NAMES[b.chainId as keyof typeof CHAIN_NAMES] ?? "—",
        status: tb(`status.${statusTone}`),
        statusTone,
        serial: serialOf(rank),
        rarity: RANK_RARITY[rank] ?? "common",
      };
    });

    return {
      hand: dealCenterOut(cards),
      pool: total,
      usdPool: sopaUsd,
      showcaseCount: count,
    };
  }, [bounties, sopaOpen, ethPrice, locale, t, tb]);

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
                value={data ? `${pool.toFixed(2)} ETH` : pendingValue}
                label={t("stats.pool")}
              />
              <StatTile value={data ? showcaseCount : pendingValue} label={t("stats.open")} />
              <StatTile
                value={
                  !data
                    ? pendingValue
                    : ethPrice > 0
                      ? formatEthToUsd(pool + usdPool / ethPrice, ethPrice, toIntlLocale(locale))
                      : status("dataUnavailable")
                }
                label={t("stats.usd")}
              />
            </>
          }
        />

        {unavailable ? (
          <p role="status" className="py-8 text-sm text-muted-foreground">
            {status("gov.loadFailed")}
          </p>
        ) : isLoading && hand.length === 0 ? (
          <div className="flex h-[420px] items-center justify-center rounded-[22px] border border-border bg-muted/30 font-mono text-sm text-muted-foreground/70">
            …
          </div>
        ) : (
          <BountyCardFan cards={hand} />
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
