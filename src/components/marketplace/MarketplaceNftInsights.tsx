"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ExternalLink, LoaderCircle, RefreshCw } from "lucide-react";
import { formatUnits } from "viem";
import { AddressDisplay } from "@/components/ui/address-display";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Link } from "@/i18n/navigation";
import { MarketplaceApiError, parseMarketplaceApiError } from "@/lib/marketplace/errors";
import {
  isNftInsightIdentity,
  marketplaceActivitySchema,
  marketplaceTraitsSchema,
  mergeNftActivity,
} from "@/lib/marketplace/nft-insights";

export function MarketplaceNftInsights({
  collectionAddress,
  tokenId,
}: {
  collectionAddress: string;
  tokenId: string;
}) {
  const t = useTranslations("marketplace.insights");
  const locale = useLocale();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("traits");
  const collection = collectionAddress.toLowerCase();
  const traits = useQuery({
    queryKey: ["marketplace", "traits", collection, tokenId],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ collection, tokenId });
      const response = await fetch(`/api/marketplace/traits?${params}`, { signal });
      if (!response.ok) throw new Error("Traits unavailable");
      const result = marketplaceTraitsSchema.parse(await response.json());
      if (!isNftInsightIdentity(result, collection, tokenId))
        throw new Error("NFT identity mismatch");
      return result;
    },
    enabled: tab === "traits",
    staleTime: 300_000,
    retry: 1,
  });
  const activityKey = ["marketplace", "activity", collection, tokenId];
  const activity = useInfiniteQuery({
    queryKey: activityKey,
    initialPageParam: null as string | null,
    queryFn: async ({ signal, pageParam }) => {
      const params = new URLSearchParams({ collection, tokenId });
      if (pageParam) params.set("cursor", pageParam);
      const response = await fetch(`/api/marketplace/activity?${params}`, { signal });
      if (!response.ok)
        throw parseMarketplaceApiError(await response.json().catch(() => null), response.status);
      const result = marketplaceActivitySchema.parse(await response.json());
      if (!isNftInsightIdentity(result, collection, tokenId))
        throw new Error("NFT identity mismatch");
      return result;
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: tab === "activity",
    staleTime: 60_000,
    retry: (count, error) =>
      !(error instanceof MarketplaceApiError && error.code === "ACTIVITY_CURSOR_EXPIRED") &&
      count < 1,
  });
  const cursorExpired =
    activity.error instanceof MarketplaceApiError &&
    activity.error.code === "ACTIVITY_CURSOR_EXPIRED";
  function retryActivity() {
    if (cursorExpired) void queryClient.resetQueries({ queryKey: activityKey, exact: true });
    else if (activity.isFetchNextPageError) void activity.fetchNextPage();
    else void activity.refetch();
  }
  const events = mergeNftActivity(activity.data?.pages.flatMap((page) => page.events) ?? []);
  const pages = activity.data?.pages ?? [];
  const combined = pages.some((page) => page.source === "combined");
  const latestPage = pages.at(-1);
  const coverage = latestPage?.coverage;
  const unavailable = (["gnars", "opensea"] as const).filter(
    (source) => latestPage?.sources?.[source].available === false,
  );

  function errorState(message: string, retry: () => void, disabled: boolean) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-destructive">{message}</span>
        <Button size="sm" variant="outline" disabled={disabled} onClick={retry}>
          <RefreshCw className="size-3.5" />
          {t("retry")}
        </Button>
      </div>
    );
  }

  return (
    <Tabs value={tab} onValueChange={setTab} className="min-w-0 border-t pt-4">
      <TabsList
        aria-label={t("label")}
        className="h-auto w-full justify-start gap-4 rounded-none border-b bg-transparent p-0"
      >
        {(["traits", "activity"] as const).map((value) => (
          <TabsTrigger
            key={value}
            value={value}
            className="min-h-10 cursor-pointer rounded-none border-0 border-b-2 border-transparent px-0 py-2 text-sm data-[state=active]:border-yellow-400 data-[state=active]:bg-transparent data-[state=active]:shadow-none"
          >
            {t(value)}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="traits" className="min-w-0 space-y-3 pt-3">
        {traits.isPending && (
          <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            {t("loadingTraits")}
          </p>
        )}
        {traits.isError &&
          errorState(t("traitsError"), () => void traits.refetch(), traits.isFetching)}
        {traits.data && traits.data.traits.length > 0 && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
            {traits.data.traits.map((trait, index) => (
              <div
                key={`${trait.type}:${index}`}
                className="min-w-0 border-b pb-2 [overflow-wrap:anywhere]"
              >
                <dt className="text-xs text-muted-foreground">{trait.type}</dt>
                <dd className="mt-1 text-sm font-medium">{trait.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {traits.data?.traits.length === 0 && !traits.isError && (
          <p className="text-xs text-muted-foreground">{t("emptyTraits")}</p>
        )}
      </TabsContent>
      <TabsContent value="activity" className="min-w-0 space-y-3 pt-3">
        <p className="text-xs text-muted-foreground">
          {t(combined ? "combinedAttribution" : "attribution")}
        </p>
        {combined && coverage && (
          <a
            href={`https://basescan.org/block/${coverage.indexedThrough}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-8 items-center gap-1 text-xs text-muted-foreground underline underline-offset-4"
          >
            {t("indexedThrough", { block: coverage.indexedThrough })}
            <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
          </a>
        )}
        {unavailable.length > 0 &&
          errorState(
            t("partialActivity", {
              sources: unavailable
                .map((source) => (source === "gnars" ? "Gnars" : "OpenSea"))
                .join(", "),
            }),
            retryActivity,
            activity.isFetching,
          )}
        {activity.isPending && (
          <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            {t("loadingActivity")}
          </p>
        )}
        {activity.isError &&
          errorState(
            t(cursorExpired ? "activityExpired" : "activityError"),
            retryActivity,
            activity.isFetching,
          )}
        {events.length > 0 && (
          <ol className="divide-y">
            {events.map((event) => (
              <li key={event.id} className="min-w-0 space-y-2 py-3 first:pt-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                  <span className="font-medium">{t(`types.${event.type}`)}</span>
                  {event.payment && (
                    <span className="min-w-0 break-all font-mono">
                      {formatUnits(BigInt(event.payment.quantity), event.payment.decimals)}{" "}
                      {event.payment.symbol}
                    </span>
                  )}
                </div>
                {event.source === "gnars-contract" && (
                  <p className="text-xs text-muted-foreground">{t("nativeSource")}</p>
                )}
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
                  {(["from", "to"] as const).map(
                    (party) =>
                      event[party] && (
                        <div key={party} className="min-w-0">
                          <dt className="text-xs text-muted-foreground">{t(party)}</dt>
                          <dd className="min-w-0">
                            <Link
                              href={`/members/${event[party]}`}
                              prefetch={false}
                              title={event[party]}
                              className="block min-w-0 rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                            >
                              <AddressDisplay
                                address={event[party]}
                                variant="compact"
                                showAvatar={false}
                                showCopy={false}
                                showExplorer={false}
                                onAddressClick={() => {}}
                                truncateLength={4}
                                className="max-w-full min-w-0 [&>span.font-mono]:min-w-0 [&>span.font-mono]:text-xs [&>span.font-mono]:[overflow-wrap:anywhere]"
                              />
                            </Link>
                          </dd>
                        </div>
                      ),
                  )}
                </dl>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <time dateTime={new Date(event.timestamp * 1000).toISOString()}>
                    {new Intl.DateTimeFormat(locale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(event.timestamp * 1000)}
                  </time>
                  <a
                    href={`https://basescan.org/tx/${event.transactionHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t("transaction")}
                    title={t("transaction")}
                    className="inline-flex min-h-8 items-center gap-1 underline underline-offset-4"
                  >
                    {t("transaction")}
                    <ExternalLink className="size-3 shrink-0" />
                  </a>
                </div>
              </li>
            ))}
          </ol>
        )}
        {!activity.isPending &&
          !activity.isError &&
          !activity.hasNextPage &&
          unavailable.length === 0 &&
          events.length === 0 && (
            <p className="text-xs text-muted-foreground">{t("emptyActivity")}</p>
          )}
        {activity.hasNextPage && !cursorExpired && (
          <Button
            size="sm"
            variant="outline"
            disabled={activity.isFetching}
            onClick={() => void activity.fetchNextPage()}
          >
            {activity.isFetchingNextPage ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <ArrowDown className="size-4" />
            )}
            {t("loadMore")}
          </Button>
        )}
      </TabsContent>
    </Tabs>
  );
}
