"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import type { MarketplaceBrowseFilters } from "@/lib/marketplace/browse-filters";
import { MarketplaceApiError, parseMarketplaceApiError } from "@/lib/marketplace/errors";
import type { MarketplacePage } from "@/types/marketplace";

export type MarketplaceView = "listings" | "catalogue" | "owned" | "selling";

export function useMarketplace(
  view: MarketplaceView,
  owner?: string,
  initialPage?: MarketplacePage,
  options: { tokenId?: string; filters?: MarketplaceBrowseFilters; enabled?: boolean } = {},
) {
  const tokenId = options.tokenId?.trim();
  const filters = view === "listings" ? options.filters : undefined;
  return useInfiniteQuery({
    queryKey: ["marketplace", view, owner?.toLowerCase() ?? null, tokenId ?? null, filters ?? null],
    initialPageParam: null as string | null,
    initialData:
      view === "listings" && initialPage && !tokenId && !filters
        ? { pages: [initialPage], pageParams: [null] }
        : undefined,
    queryFn: async ({ pageParam, signal }): Promise<MarketplacePage> => {
      const params = new URLSearchParams({ view });
      if (owner && (view === "owned" || view === "selling")) params.set("owner", owner);
      if (pageParam) params.set("cursor", pageParam);
      if (filters?.sort) params.set("sort", filters.sort);
      if (filters?.minPriceWei) params.set("minPriceWei", filters.minPriceWei);
      if (filters?.maxPriceWei) params.set("maxPriceWei", filters.maxPriceWei);
      const response = await fetch(
        tokenId
          ? `/api/marketplace/nfts/${encodeURIComponent(tokenId)}`
          : `/api/marketplace?${params}`,
        { signal },
      );
      if (!response.ok)
        throw parseMarketplaceApiError(await response.json().catch(() => null), response.status);
      return response.json();
    },
    enabled:
      options.enabled !== false &&
      (!(["owned", "selling"] as MarketplaceView[]).includes(view) || !!owner) &&
      (!tokenId || /^\d{1,78}$/.test(tokenId)),
    getNextPageParam: (page) => (tokenId ? null : page.nextCursor),
    staleTime: 30_000,
    retry: (attempt, error) =>
      attempt < 1 && (!(error instanceof MarketplaceApiError) || error.retryable),
    refetchOnWindowFocus: true,
  });
}
