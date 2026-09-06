"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import type { MarketplacePage } from "@/types/marketplace";

export type MarketplaceView = "listings" | "catalogue" | "owned";

export function useMarketplace(
  view: MarketplaceView,
  owner?: string,
  initialPage?: MarketplacePage,
) {
  return useInfiniteQuery({
    queryKey: ["marketplace", view, owner?.toLowerCase() ?? null],
    initialPageParam: null as string | null,
    initialData:
      view === "catalogue" && initialPage
        ? { pages: [initialPage], pageParams: [null] }
        : undefined,
    queryFn: async ({ pageParam, signal }): Promise<MarketplacePage> => {
      const params = new URLSearchParams({ view });
      if (owner && view === "owned") params.set("owner", owner);
      if (pageParam) params.set("cursor", pageParam);
      const response = await fetch(`/api/marketplace?${params}`, { signal });
      if (!response.ok) throw new Error("Marketplace unavailable");
      return response.json();
    },
    enabled: view !== "owned" || !!owner,
    getNextPageParam: (page) => page.nextCursor,
    staleTime: 30_000,
    retry: 1,
    refetchOnWindowFocus: true,
  });
}
