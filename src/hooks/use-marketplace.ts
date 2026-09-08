"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { MarketplaceApiError, parseMarketplaceApiError } from "@/lib/marketplace/errors";
import type { MarketplacePage } from "@/types/marketplace";

export type MarketplaceView = "listings" | "catalogue" | "owned" | "selling";

export function useMarketplace(
  view: MarketplaceView,
  owner?: string,
  initialPage?: MarketplacePage,
  options: { tokenId?: string } = {},
) {
  const tokenId = options.tokenId?.trim();
  return useInfiniteQuery({
    queryKey: ["marketplace", view, owner?.toLowerCase() ?? null, tokenId ?? null],
    initialPageParam: null as string | null,
    initialData:
      view === "catalogue" && initialPage && !tokenId
        ? { pages: [initialPage], pageParams: [null] }
        : undefined,
    queryFn: async ({ pageParam, signal }): Promise<MarketplacePage> => {
      const params = new URLSearchParams({ view });
      if (owner && (view === "owned" || view === "selling")) params.set("owner", owner);
      if (pageParam) params.set("cursor", pageParam);
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
      (!(["owned", "selling"] as MarketplaceView[]).includes(view) || !!owner) &&
      (!tokenId || /^\d{1,78}$/.test(tokenId)),
    getNextPageParam: (page) => (tokenId ? null : page.nextCursor),
    staleTime: 30_000,
    retry: (attempt, error) =>
      attempt < 1 && (!(error instanceof MarketplaceApiError) || error.retryable),
    refetchOnWindowFocus: true,
  });
}
