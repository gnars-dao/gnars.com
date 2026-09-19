"use client";

import { useEffect, useState, type MouseEvent } from "react";
import { useTranslations } from "next-intl";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowDown, LoaderCircle, RefreshCw, Search, X } from "lucide-react";
import type { Address } from "viem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMarketplacePrice } from "@/lib/marketplace-display";
import type { MarketplaceBrowseFilters } from "@/lib/marketplace/browse-filters";
import { mergeMarketplaceItems } from "@/lib/marketplace/merge-items";
import { cn } from "@/lib/utils";
import type { CommunityMarketplacePage, MarketplaceItem } from "@/types/marketplace";
import {
  isSameSweepSelection,
  selectableSweepOffer,
  type MarketplaceSweepSelection,
} from "./marketplace-sweep-model";
import { MarketplaceCard } from "./MarketplaceCard";

function sortByMatchingPrice(items: MarketplaceItem[]) {
  const bestPrice = (item: MarketplaceItem) =>
    item.offers.reduce<bigint | undefined>(
      (best, offer) =>
        best === undefined || BigInt(offer.priceWei) < best ? BigInt(offer.priceWei) : best,
      undefined,
    );
  return [...items].sort((a, b) => {
    const left = bestPrice(a);
    const right = bestPrice(b);
    if (left === undefined) return right === undefined ? 0 : 1;
    if (right === undefined) return -1;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

export function MarketplaceSaleBands({
  items,
  pending,
  failed,
  complete,
  hasMore,
  onRetry,
  onSelect,
  sweepSelections = [],
  sweepEnabled,
  sweepBuyer,
  onSweepSelect,
  filters,
  enabled,
}: {
  items: MarketplaceItem[];
  pending: boolean;
  failed: boolean;
  complete: boolean;
  hasMore: boolean;
  onRetry: () => void;
  onSelect: (item: MarketplaceItem, event: MouseEvent<HTMLButtonElement>) => void;
  sweepSelections?: MarketplaceSweepSelection[];
  sweepEnabled?: { native: boolean; opensea: boolean };
  sweepBuyer?: Address;
  onSweepSelect?: (selection: MarketplaceSweepSelection) => void;
  filters: MarketplaceBrowseFilters;
  enabled: boolean;
}) {
  const t = useTranslations("marketplace");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [searchReady, setSearchReady] = useState(false);
  useEffect(() => {
    const restore = () => {
      const raw = new URLSearchParams(window.location.search).get("communitySearch") ?? "";
      const value = raw.trim();
      const valid = value.length <= 100 && !/[\x00-\x1f\x7f]/.test(value) ? value : "";
      setSearch(valid);
      setDraft(valid);
      setSearchReady(true);
    };
    restore();
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  function findCommunity(value: string) {
    const term = value.trim();
    setSearch(term);
    setDraft(term);
    const url = new URL(window.location.href);
    if (term) url.searchParams.set("communitySearch", term);
    else url.searchParams.delete("communitySearch");
    window.history.replaceState(window.history.state, "", url);
  }
  const community = useInfiniteQuery({
    queryKey: ["marketplace", "community", "listings", search, filters],
    enabled: enabled && searchReady,
    initialPageParam: "",
    queryFn: async ({ pageParam, signal }): Promise<CommunityMarketplacePage> => {
      const params = new URLSearchParams();
      if (pageParam) params.set("cursor", pageParam);
      if (search) params.set("q", search);
      if (filters.sort) params.set("sort", filters.sort);
      if (filters.minPriceWei) params.set("minPriceWei", filters.minPriceWei);
      if (filters.maxPriceWei) params.set("maxPriceWei", filters.maxPriceWei);
      const response = await fetch(`/api/marketplace/community?${params}`, { signal });
      if (!response.ok) throw new Error("Community listings unavailable");
      const page: CommunityMarketplacePage = await response.json();
      if (
        !page ||
        typeof page.available !== "boolean" ||
        !Array.isArray(page.items) ||
        (page.nextCursor !== null && typeof page.nextCursor !== "string")
      )
        throw new Error("Invalid community listings response");
      return page;
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 30_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const communityItems = mergeMarketplaceItems(
    community.data?.pages.flatMap((page) => page.items) ?? [],
  );
  const communityPartial = community.data?.pages.some((page) => !page.available) ?? false;
  const groups = [
    {
      key: "native",
      items: sortByMatchingPrice(
        items
          .map((item) => ({
            ...item,
            offers: item.offers.filter((offer) => offer.source !== "opensea"),
          }))
          .filter((item) => item.offers.length),
      ),
      pending,
      failed,
      complete,
      hasMore,
      retry: onRetry,
    },
    {
      key: "community",
      items: sortByMatchingPrice(communityItems),
      pending: community.isPending,
      failed: community.isError || communityPartial,
      complete: !community.isError && !communityPartial,
      hasMore: community.hasNextPage,
      retry: () => void community.refetch(),
    },
    {
      key: "opensea",
      items: sortByMatchingPrice(
        items
          .map((item) => ({
            ...item,
            offers: item.offers.filter((offer) => offer.source === "opensea"),
          }))
          .filter((item) => item.offers.length),
      ),
      pending,
      failed,
      complete,
      hasMore,
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
          {group.key === "community" && (
            <form
              className="relative mb-5 flex w-full max-w-md items-center"
              onSubmit={(event) => {
                event.preventDefault();
                findCommunity(draft);
              }}
            >
              <Search className="pointer-events-none absolute left-3 size-4 text-muted-foreground" />
              <Input
                aria-label={t("community.search")}
                placeholder={t("community.search")}
                value={draft}
                disabled={!searchReady}
                maxLength={100}
                onChange={(event) => setDraft(event.target.value)}
                className="h-10 pr-20 pl-9"
              />
              <div className="absolute right-1 flex gap-1">
                {(draft || search) && (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-8"
                    aria-label={t("community.clearSearch")}
                    onClick={() => findCommunity("")}
                  >
                    <X className="size-4" />
                  </Button>
                )}
                <Button
                  type="submit"
                  disabled={!searchReady}
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  aria-label={t("community.find")}
                >
                  <Search className="size-4" />
                </Button>
              </div>
            </form>
          )}
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
              {group.items.map((item) => {
                const sweepOffer =
                  (group.key === "native" && sweepEnabled?.native) ||
                  (group.key === "opensea" && sweepEnabled?.opensea)
                    ? selectableSweepOffer(item, sweepBuyer)
                    : undefined;
                const selected =
                  !!sweepOffer &&
                  sweepSelections.some((entry) =>
                    isSameSweepSelection(entry, { item, offer: sweepOffer }),
                  );
                const alreadyInCart = sweepSelections.some(
                  (entry) => entry.item.tokenId === item.tokenId,
                );
                return (
                  <div
                    key={`${item.collectionAddress ?? "gnars"}:${item.tokenId}`}
                    className={cn(
                      "flex min-w-0 flex-col gap-2 rounded-lg",
                      selected && "outline-2 outline-offset-4 outline-emerald-500",
                    )}
                  >
                    <MarketplaceCard
                      item={item}
                      view="listings"
                      exactSearch={false}
                      sourcesComplete={group.complete}
                      onClick={(event) => onSelect(item, event)}
                    />
                    {sweepOffer && (
                      <label className="flex min-h-11 cursor-pointer items-center gap-2 px-1 text-[11px]">
                        <input
                          type="checkbox"
                          className="size-4 shrink-0 cursor-pointer accent-emerald-600"
                          checked={selected}
                          disabled={!alreadyInCart && sweepSelections.length >= 10}
                          aria-label={t("sweep.select", {
                            id: item.tokenId,
                            price: formatMarketplacePrice(sweepOffer.priceWei).exact,
                          })}
                          onChange={() => onSweepSelect?.({ item, offer: sweepOffer })}
                        />
                        <span className="min-w-0 flex-1 text-muted-foreground">
                          {t(`sourceNames.${sweepOffer.source}`)}
                        </span>
                        <span
                          className="break-all text-right font-mono"
                          title={`${formatMarketplacePrice(sweepOffer.priceWei).exact} ETH`}
                        >
                          {formatMarketplacePrice(sweepOffer.priceWei).display} ETH
                        </span>
                      </label>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            !group.failed && (
              <p className="py-8 text-sm text-muted-foreground">
                {t(
                  group.hasMore
                    ? "filters.emptyPage"
                    : group.complete
                      ? "empty"
                      : "availabilityUnknown",
                )}
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
