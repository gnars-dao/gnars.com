"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { PlusCircle, Search, X } from "lucide-react";
import { formatEther, formatUnits } from "viem";
import { BountyGrid } from "@/components/bounties/BountyGrid";
import { CreateBountyModal } from "@/components/bounties/CreateBountyModal";
import { PendingWithdrawalBanner } from "@/components/bounties/PendingWithdrawalBanner";
import { Button } from "@/components/ui/button";
import ContentImage from "@/components/ui/content-image";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useEthPrice } from "@/hooks/use-eth-price";
import { usePoidhSopaBounties } from "@/hooks/use-poidh-sopa-bounties";
import { usePoidhBounties } from "@/hooks/usePoidhBounties";
import { isPoidhSopaEnabled, POIDH_SOPA } from "@/lib/config";
import { toIntlLocale } from "@/lib/i18n/format";
import { displayAmount } from "@/lib/poidh-sopa/bounty-data";
import { formatTokenAmount, isEthToken } from "@/lib/poidh-sopa/tokens";
import type { SopaBountiesResult, SopaStatus } from "@/lib/poidh-sopa/types";
import { classifyGnarsDiscipline, GNARS_DISCIPLINES } from "@/lib/poidh/keywords";
import type { PoidhBounty } from "@/types/poidh";

const BANNER_IMAGES = [
  {
    src: "https://images.hive.blog/DQmZtLJgBNArPUScjdJzf4bn56wdn6BZ3Nwwd8rPoUFKc1f/Captura%20de%20Tela%202026-04-24%20a%CC%80s%2013.06.11.png",
    fit: "contain",
  },
  {
    src: "https://img.paragraph.com/cdn-cgi/image/format=auto,width=1080,quality=85/https://storage.googleapis.com/papyrus_images/44c796ba01b6ab07b5ad419da0dc4195.jpg",
    fit: "cover",
  },
  {
    src: "https://images.hive.blog/DQmRam7hFrAUvstnn4aodL58w7oqgEWLsZGK3Qh5DHrgqp1/Captura%20de%20Tela%202026-04-24%20a%CC%80s%2013.15.40.png",
    fit: "cover",
  },
] as const;

const SOPA_STATUS_FOR_FILTER: Record<"open" | "closed" | "voting" | "all", SopaStatus[] | null> = {
  open: ["open"],
  voting: ["voting"],
  closed: ["paid", "cancelled"],
  all: null,
};

/** Reward tokens pegged to the dollar: they count toward the USD value at face. */
const USD_STABLE_SYMBOLS = new Set(["USDC"]);

type StatusFilter = "open" | "closed" | "voting" | "all";
type SourceFilter = "all" | "v3" | "sopa";

// Every category by default: starting on one discipline hid recent community bounties.
const DEFAULT_CATEGORY = "all";

/** Lets a row of tabs scroll inside the page on narrow screens instead of widening it. */
const TAB_SCROLLER = "-mx-4 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0";

interface BountiesViewProps {
  initialBounties: PoidhBounty[];
  /** PoidhSopa list from the server render; undefined when Sopa is not configured. */
  initialSopa?: SopaBountiesResult;
}

export function BountiesView({ initialBounties, initialSopa }: BountiesViewProps) {
  const t = useTranslations("bounties");
  const locale = useLocale();
  const [status, setStatus] = useState<StatusFilter>("open");
  const [searchQuery, setSearchQuery] = useState("");
  // Disciplines sort the POIDH feed, which is everyone's bounties; the team's Sopa
  // bounties are shown whatever discipline is picked.
  const [categoryFilter, setCategoryFilter] = useState<string>(DEFAULT_CATEGORY);
  const sopaEnabled = isPoidhSopaEnabled();
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");

  const CATEGORIES = [
    { key: "all", label: t("filters.all") },
    ...GNARS_DISCIPLINES.map((d) => ({ key: d, label: t(`filters.${d}`) })),
  ];

  const { data, isLoading, error } = usePoidhBounties({
    status,
    // Only use initialData for the default "open" status
    initialData:
      status === "open" ? { bounties: initialBounties, total: initialBounties.length } : undefined,
  });

  const { ethPrice } = useEthPrice();
  const sopaQuery = usePoidhSopaBounties(initialSopa);
  const query = searchQuery.trim().toLowerCase();

  const teamBounties = useMemo(() => {
    if (!sopaEnabled || sourceFilter === "v3") return [];
    const statuses = SOPA_STATUS_FOR_FILTER[status];
    return (sopaQuery.data?.bounties ?? []).filter((b) => {
      if (statuses && !statuses.includes(b.status)) return false;
      if (query && !`${b.title} ${b.description}`.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [sopaEnabled, sourceFilter, status, query, sopaQuery.data]);

  const communityBounties = useMemo(() => {
    if (sourceFilter === "sopa") return [];
    return (data?.bounties ?? []).filter((bounty) => {
      const text = `${bounty.title} ${bounty.description}`;
      if (query && !text.toLowerCase().includes(query)) return false;
      if (categoryFilter === "all") return true;
      return classifyGnarsDiscipline(text) === categoryFilter;
    });
  }, [data?.bounties, query, categoryFilter, sourceFilter]);

  const totalValue = useMemo(() => {
    let totalWei = communityBounties.reduce((sum, bounty) => {
      return sum + BigInt(bounty.amount ?? 0);
    }, 0n);
    // Sopa ETH bounties join the ETH pool; other tokens are listed beside it.
    const otherTokens = new Map<string, bigint>();
    for (const b of teamBounties) {
      const amount = BigInt(displayAmount(b));
      if (isEthToken(b.token)) totalWei += amount;
      else
        otherTokens.set(
          b.token.toLowerCase(),
          (otherTokens.get(b.token.toLowerCase()) ?? 0n) + amount,
        );
    }
    let stableUsd = 0;
    const others = [...otherTokens.entries()]
      .map(([address, raw]) => {
        const token = POIDH_SOPA.tokens.find((tk) => tk.address.toLowerCase() === address);
        if (!token) return null;
        if (USD_STABLE_SYMBOLS.has(token.symbol)) {
          stableUsd += parseFloat(formatUnits(raw, token.decimals));
        }
        return `${formatTokenAmount(raw, token.decimals, 2)} ${token.symbol}`;
      })
      .filter((x): x is string => Boolean(x));
    const totalEth = parseFloat(formatEther(totalWei));
    const usd = new Intl.NumberFormat(toIntlLocale(locale), {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(totalEth * ethPrice + stableUsd);
    return {
      eth: formatTokenAmount(totalWei, 18, 4),
      usd,
      count: communityBounties.length + teamBounties.length,
      others,
    };
  }, [communityBounties, teamBounties, ethPrice, locale]);

  // The two sources load and fail independently: one being down or slow must never hide
  // the other's bounties or stats.
  const v3Shown = sourceFilter !== "sopa";
  const sopaShown = sopaEnabled && sourceFilter !== "v3";
  const sopaReady = sopaShown && Boolean(sopaQuery.data);
  const v3Settled = !v3Shown || (Boolean(data) && !isLoading) || Boolean(error);
  const sopaSettled = !sopaShown || Boolean(sopaQuery.data) || Boolean(sopaQuery.error);
  // An empty team section only earns its place when the team is all that was asked for.
  const teamSectionShown =
    sopaShown &&
    (sourceFilter === "sopa" ||
      sopaQuery.isLoading ||
      Boolean(sopaQuery.error) ||
      teamBounties.length > 0);

  const resetFilters = () => {
    setStatus("open");
    setSearchQuery("");
    setCategoryFilter(DEFAULT_CATEGORY);
    setSourceFilter("all");
  };
  const canReset = !(
    status === "open" &&
    !query &&
    categoryFilter === DEFAULT_CATEGORY &&
    sourceFilter === "all"
  );

  const poolLabel = (() => {
    if (status === "open") return t("stats.openPool");
    if (status === "closed") return t("stats.closedPool");
    if (status === "voting") return t("stats.votingPool");
    return t("stats.totalPool");
  })();

  const bountiesLabel = (() => {
    if (status === "open") return t("stats.openBounties");
    if (status === "closed") return t("stats.closedBounties");
    if (status === "voting") return t("stats.votingBounties");
    return t("stats.bounties");
  })();

  return (
    <div className="container mx-auto px-4 py-8 max-w-7xl">
      <div className="space-y-6">
        <PendingWithdrawalBanner />
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{t("title")}</h1>
            <p className="text-sm text-muted-foreground mt-1 max-w-3xl">{t("description")}</p>
          </div>
          <CreateBountyModal>
            <Button className="shrink-0">
              <PlusCircle className="w-4 h-4 mr-2" />
              <span className="hidden sm:inline">{t("cta.createBounty")}</span>
              <span className="sm:hidden">{t("cta.create")}</span>
            </Button>
          </CreateBountyModal>
        </div>

        {/* Banner: a swipeable strip on phones, three panels from md up */}
        <div className="overflow-hidden rounded-3xl border border-border bg-muted/30">
          <div className="flex snap-x snap-mandatory gap-px overflow-x-auto bg-border [scrollbar-width:none] md:grid md:grid-cols-3 md:overflow-visible">
            {BANNER_IMAGES.map(({ src, fit }, index) => (
              <div
                key={src}
                className="flex h-[170px] w-[85%] shrink-0 snap-center items-center justify-center bg-background/40 md:h-[210px] md:w-auto"
              >
                <ContentImage
                  src={src}
                  width={720}
                  height={210}
                  sizes="(max-width: 768px) 85vw, 33vw"
                  alt={t("banner.alt", { index: index + 1 })}
                  className={`h-full w-full ${fit === "cover" ? "object-cover" : "object-contain"}`}
                />
              </div>
            ))}
          </div>
        </div>

        {/* Pool stats */}
        {v3Settled && sopaSettled && (Boolean(data) || sopaReady) && (
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border bg-muted/30 px-5 py-4 sm:grid-cols-3">
            <div className="col-span-2 sm:col-span-1">
              <div className="text-2xl font-bold tabular-nums tracking-tight">
                {totalValue.eth}
                <span className="text-base font-semibold text-muted-foreground ml-1.5">ETH</span>
              </div>
              {totalValue.others.length > 0 && (
                <div className="text-xs font-medium text-foreground/80 mt-0.5 tabular-nums">
                  + {totalValue.others.join(" · ")}
                </div>
              )}
              <div className="text-xs text-muted-foreground mt-0.5">{poolLabel}</div>
            </div>
            {ethPrice > 0 && (
              <div>
                <div className="text-2xl font-bold tabular-nums tracking-tight text-emerald-600 dark:text-emerald-400">
                  {totalValue.usd}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">{t("stats.usdValue")}</div>
              </div>
            )}
            <div>
              <div className="text-2xl font-bold tabular-nums tracking-tight">
                {totalValue.count}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">{bountiesLabel}</div>
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-col gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <Input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("filters.search")}
              aria-label={t("filters.search")}
              className="pl-9 pr-9 [&::-webkit-search-cancel-button]:hidden"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                aria-label={t("filters.clearSearch")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 cursor-pointer rounded-md p-1.5 text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className={TAB_SCROLLER}>
              <Tabs value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
                <TabsList className="w-max">
                  <TabsTrigger value="open">{t("filters.open")}</TabsTrigger>
                  <TabsTrigger value="voting">{t("filters.voting")}</TabsTrigger>
                  <TabsTrigger value="closed">{t("filters.closed")}</TabsTrigger>
                  <TabsTrigger value="all">{t("filters.all")}</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            {sopaEnabled && (
              <div className={TAB_SCROLLER}>
                <Tabs
                  value={sourceFilter}
                  onValueChange={(v) => setSourceFilter(v as SourceFilter)}
                >
                  <TabsList className="w-max" aria-label={t("sopa.filters.sourceLabel")}>
                    <TabsTrigger value="all">{t("sopa.filters.allSources")}</TabsTrigger>
                    <TabsTrigger value="sopa">{t("sopa.filters.sopa")}</TabsTrigger>
                    <TabsTrigger value="v3">{t("sopa.filters.poidh")}</TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>
            )}
          </div>
        </div>

        {/* The team's own bounties, whatever discipline is picked below */}
        {teamSectionShown && (
          <section className="space-y-4">
            <SectionHeading
              title={t("sections.team")}
              count={sopaQuery.data ? teamBounties.length : null}
            />
            {sopaQuery.error && (
              <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {t("sopa.listError")}
              </div>
            )}
            {!sopaQuery.error && (
              <BountyGrid
                bounties={[]}
                sopaBounties={teamBounties}
                isLoading={sopaQuery.isLoading}
                error={null}
                skeletonCount={3}
                onReset={canReset ? resetFilters : undefined}
              />
            )}
          </section>
        )}

        {v3Shown && (
          <section className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              {sopaEnabled ? (
                <SectionHeading
                  title={t("sections.community")}
                  count={data && !isLoading ? communityBounties.length : null}
                />
              ) : (
                <span />
              )}
              <div className={TAB_SCROLLER}>
                <Tabs value={categoryFilter} onValueChange={(v) => setCategoryFilter(v)}>
                  <TabsList className="w-max">
                    {CATEGORIES.map(({ key, label }) => (
                      <TabsTrigger key={key} value={key}>
                        {label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              </div>
            </div>
            <BountyGrid
              bounties={communityBounties}
              isLoading={isLoading}
              error={error}
              onReset={canReset ? resetFilters : undefined}
            />
          </section>
        )}

        <div className="rounded-3xl border border-border bg-muted/30 p-6 md:p-8">
          <div className="max-w-4xl space-y-5">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {t("manifesto.sectionLabel")}
              </div>
            </div>
            <div className="space-y-4 text-sm leading-7 text-muted-foreground md:text-base">
              <p>{t("manifesto.p1")}</p>
              <div className="space-y-2">
                <p className="text-foreground">{t("manifesto.howItWorksLabel")}</p>
                <p>{t("manifesto.howItWorksBody")}</p>
              </div>
              <p className="pt-2 text-xs text-muted-foreground/80">
                {t.rich("manifesto.poweredByPoidh", {
                  link: (chunks) => (
                    <a
                      href="https://poidh.xyz"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-foreground underline underline-offset-4 decoration-muted-foreground/40 hover:decoration-foreground transition-colors"
                    >
                      {chunks}
                    </a>
                  ),
                })}
              </p>
              {sopaEnabled && (
                <p className="text-xs text-muted-foreground/80">{t("sopa.poweredBy")}</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionHeading({ title, count }: { title: string; count: number | null }) {
  return (
    <h2 className="flex items-baseline gap-2 text-lg font-semibold tracking-tight">
      {title}
      {count !== null && (
        <span className="text-sm font-medium tabular-nums text-muted-foreground">{count}</span>
      )}
    </h2>
  );
}
