"use client";

import type { MouseEvent } from "react";
import { useTranslations } from "next-intl";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowDown, LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CommunityMarketplacePage, MarketplaceItem } from "@/types/marketplace";
import { MarketplaceCard } from "./MarketplaceCard";

export function MarketplaceSaleBands({
  items,
  pending,
  failed,
  complete,
  onRetry,
  onSelect,
}: {
  items: MarketplaceItem[];
  pending: boolean;
  failed: boolean;
  complete: boolean;
  onRetry: () => void;
  onSelect: (item: MarketplaceItem, event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const t = useTranslations("marketplace");
  const community = useInfiniteQuery({
    queryKey: ["marketplace", "community", "listings"],
    initialPageParam: "",
    queryFn: async ({ pageParam, signal }): Promise<CommunityMarketplacePage> => {
      const params = new URLSearchParams();
      if (pageParam) params.set("cursor", pageParam);
      const response = await fetch(`/api/marketplace/community?${params}`, { signal });
      if (!response.ok) throw new Error("Community listings unavailable");
      const page: CommunityMarketplacePage = await response.json();
      if (!page.available) throw new Error("Community listings unavailable");
      return page;
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 30_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const communityItems = [
    ...new Map(
      (community.data?.pages.flatMap((page) => page.items) ?? []).map(
        (item) => [`${item.collectionAddress?.toLowerCase()}:${item.tokenId}`, item] as const,
      ),
    ).values(),
  ];
  const groups = [
    {
      key: "native",
      items: items
        .map((item) => ({
          ...item,
          offers: item.offers.filter((offer) => offer.source !== "opensea"),
        }))
        .filter((item) => item.offers.length),
      pending,
      failed,
      complete,
      retry: onRetry,
    },
    {
      key: "community",
      items: communityItems,
      pending: community.isPending,
      failed: community.isError,
      complete: !community.isError,
      retry: () => void community.refetch(),
    },
    {
      key: "opensea",
      items: items
        .map((item) => ({
          ...item,
          offers: item.offers.filter((offer) => offer.source === "opensea"),
        }))
        .filter((item) => item.offers.length),
      pending,
      failed,
      complete,
      retry: onRetry,
    },
  ];
  return (
    <div className="space-y-12">
      {groups.map((group) => (
        <section
          key={group.key}
          aria-labelledby={`sale-band-${group.key}`}
          className="border-t pt-6"
        >
          <h2 id={`sale-band-${group.key}`} className="mb-5 text-lg font-semibold">
            {t(`sections.${group.key}`)}
          </h2>
          {group.failed && (
            <div
              role="alert"
              className="mb-4 flex flex-wrap items-center gap-3 text-sm text-muted-foreground"
            >
              {t("loadError")}
              <Button size="sm" variant="outline" onClick={group.retry}>
                <RefreshCw className="size-4" />
                {t("retry")}
              </Button>
            </div>
          )}
          {group.pending ? (
            <div
              aria-label={t("loading")}
              className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4"
            >
              {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="aspect-[1/1.25] animate-pulse rounded-lg bg-muted" />
              ))}
            </div>
          ) : group.items.length ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-6 md:grid-cols-3 lg:grid-cols-4">
              {group.items.map((item) => (
                <MarketplaceCard
                  key={`${item.collectionAddress ?? "gnars"}:${item.tokenId}`}
                  item={item}
                  view="listings"
                  exactSearch={false}
                  sourcesComplete={group.complete}
                  onClick={(event) => onSelect(item, event)}
                />
              ))}
            </div>
          ) : (
            !group.failed && (
              <p className="py-8 text-sm text-muted-foreground">
                {t(group.complete ? "empty" : "availabilityUnknown")}
              </p>
            )
          )}
          {group.key === "community" && community.hasNextPage && (
            <div className="mt-6 flex justify-center">
              <Button
                variant="outline"
                disabled={community.isFetchingNextPage}
                onClick={() => void community.fetchNextPage()}
              >
                {community.isFetchingNextPage ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <ArrowDown className="size-4" />
                )}
                {t("loadMore")}
              </Button>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
