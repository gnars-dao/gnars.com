"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowDown, LoaderCircle, RefreshCw } from "lucide-react";
import type { Address } from "viem";
import { Button } from "@/components/ui/button";
import type { MarketplaceItem } from "@/types/marketplace";
import { NftArtwork } from "./NftArtwork";

type WalletNftPage = {
  items: (MarketplaceItem & { collectionAddress: Address })[];
  nextCursor: string | null;
};

export function WalletNftPicker({
  owner,
  disabled = false,
  onSelect,
}: {
  owner: Address;
  disabled?: boolean;
  onSelect: (selection: { collectionAddress: Address; tokenId: string }) => void;
}) {
  const t = useTranslations("marketplace");
  const headingId = useId();
  const wallet = useInfiniteQuery({
    queryKey: ["marketplace", "community", "wallet", owner.toLowerCase()],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }): Promise<WalletNftPage> => {
      const params = new URLSearchParams({ owner });
      if (pageParam) params.set("cursor", pageParam);
      const response = await fetch(`/api/marketplace/community/wallet?${params}`, { signal });
      if (!response.ok) throw new Error("Wallet NFTs unavailable");
      return response.json();
    },
    enabled: !!owner,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 30_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const items = [
    ...new Map(
      (wallet.data?.pages.flatMap((page) => page.items) ?? []).map(
        (item) => [`${item.collectionAddress.toLowerCase()}:${item.tokenId}`, item] as const,
      ),
    ).values(),
  ];

  return (
    <section aria-labelledby={headingId} className="min-w-0 space-y-4">
      <h3 id={headingId} className="text-sm font-medium">
        {t("community.wallet.title")}
      </h3>
      {wallet.isPending && (
        <div role="status" className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden="true" />
          {t("community.wallet.loading")}
        </div>
      )}
      {wallet.isError && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-destructive">
            {t("community.wallet.error")}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || wallet.isFetching}
            onClick={() =>
              void (wallet.isFetchNextPageError ? wallet.fetchNextPage() : wallet.refetch())
            }
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            {t("retry")}
          </Button>
        </div>
      )}
      {!wallet.isPending && !wallet.isError && !items.length && !wallet.hasNextPage && (
        <p className="py-6 text-sm text-muted-foreground">{t("community.wallet.empty")}</p>
      )}
      {!!items.length && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {items.map((item) => (
            <button
              key={`${item.collectionAddress.toLowerCase()}:${item.tokenId}`}
              type="button"
              disabled={disabled}
              aria-label={t("community.wallet.select", { name: item.name })}
              onClick={() =>
                onSelect({ collectionAddress: item.collectionAddress, tokenId: item.tokenId })
              }
              className="min-w-0 cursor-pointer overflow-hidden rounded-lg border text-left transition-colors hover:border-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
            >
              <NftArtwork item={item} sizes="(max-width: 767px) 45vw, 160px" />
              <div className="min-w-0 space-y-1 p-2.5">
                <p className="truncate text-sm font-medium" title={item.name}>
                  {item.name}
                </p>
                <p
                  className="truncate text-xs text-muted-foreground"
                  title={item.collectionName || `#${item.tokenId}`}
                >
                  {item.collectionName || `#${item.tokenId}`}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}
      {wallet.hasNextPage && !wallet.isFetchNextPageError && (
        <Button
          type="button"
          variant="outline"
          disabled={disabled || wallet.isFetching}
          onClick={() => void wallet.fetchNextPage()}
          className="w-full"
        >
          {wallet.isFetchingNextPage ? (
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <ArrowDown className="size-4" aria-hidden="true" />
          )}
          {t(wallet.isFetchingNextPage ? "community.wallet.loading" : "community.wallet.loadMore")}
        </Button>
      )}
    </section>
  );
}
