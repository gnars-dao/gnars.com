"use client";

import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, RefreshCw, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatMarketplacePrice } from "@/lib/marketplace-display";
import type { ExternalCollectionKey } from "@/lib/marketplace/external-collections";
import { externalCollectionUrl } from "@/lib/marketplace/external-collections";
import type { ExternalCollectionItem, ExternalCollectionPage } from "@/types/marketplace";
import { NftArtwork } from "./NftArtwork";

function ExternalCollectionCard({ item }: { item: ExternalCollectionItem }) {
  const t = useTranslations("marketplace");
  const price = formatMarketplacePrice(item.priceWei);
  return (
    <a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t("collections.openItem", { name: item.name })}
      className="group relative flex w-full min-w-0 flex-col overflow-hidden rounded-lg border border-zinc-400/60 bg-zinc-100 text-left shadow-[0_1px_3px_#00000014,inset_0_0_0_1px_#ffffff80] transition-shadow duration-200 hover:shadow-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring dark:border-zinc-500/70 dark:bg-zinc-900"
    >
      <div className="relative m-1.5 mb-0 overflow-hidden rounded-[4px] border border-black/10 dark:border-white/10">
        <NftArtwork
          item={{
            tokenId: item.tokenId,
            name: item.name,
            image: item.image,
            owner: null,
            offers: [],
          }}
          sizes="(max-width: 767px) 50vw, (max-width: 1023px) 33vw, 280px"
        />
        <span className="absolute top-2 left-2 inline-flex items-center gap-1.5 rounded bg-black/75 px-2 py-1 text-[10px] font-semibold text-white shadow-sm">
          <span className="size-1.5 rounded-full bg-violet-400" />
          {t("collections.chain")}
        </span>
      </div>
      <div className="flex w-full flex-1 flex-col gap-1.5 p-2 md:gap-2 md:p-3">
        <h3 className="truncate text-sm font-semibold md:text-base" title={item.name}>
          {item.name}
        </h3>
        <div className="flex-1">
          <p className="mb-0.5 text-[10px] text-muted-foreground">{t("cardPrice")}</p>
          <p
            className="break-words font-mono text-sm font-semibold tabular-nums [overflow-wrap:anywhere] md:text-lg"
            title={`${price.exact} ETH`}
            aria-label={`${price.exact} ETH`}
          >
            {price.display} ETH
          </p>
        </div>
        <div className="flex items-center justify-between gap-2 border-t pt-1.5 text-[10px] text-muted-foreground md:text-xs">
          <span className="flex min-w-0 items-center gap-1.5">
            <Tag className="size-3 shrink-0" aria-hidden="true" />
            {t("collections.externalCheckout")}
          </span>
          <ArrowUpRight
            className="size-4 shrink-0 text-foreground transition-transform motion-safe:group-hover:translate-x-0.5 motion-safe:group-hover:-translate-y-0.5"
            aria-hidden="true"
          />
        </div>
      </div>
    </a>
  );
}

export function ExternalCollectionGrid({
  collection,
  enabled,
}: {
  collection: ExternalCollectionKey;
  enabled: boolean;
}) {
  const t = useTranslations("marketplace");
  const feed = useQuery({
    queryKey: ["marketplace", "external-collection", collection],
    enabled,
    queryFn: async ({ signal }): Promise<ExternalCollectionPage> => {
      const response = await fetch(
        `/api/marketplace/collections?collection=${encodeURIComponent(collection)}`,
        { signal },
      );
      if (!response.ok) throw new Error("Collection listings unavailable");
      const page: ExternalCollectionPage = await response.json();
      if (!page || typeof page.available !== "boolean" || !Array.isArray(page.items))
        throw new Error("Invalid collection listings response");
      return page;
    },
    staleTime: 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const unavailable = feed.isError || feed.data?.available === false;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t("collections.inlineDescription")}</p>
        <Button asChild variant="outline" size="sm">
          <a href={externalCollectionUrl(collection)} target="_blank" rel="noopener noreferrer">
            {t("collections.openExternal")}
            <ArrowUpRight className="size-4" aria-hidden="true" />
          </a>
        </Button>
      </div>
      {unavailable && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground"
        >
          {t("loadError")}
          <Button size="sm" variant="outline" onClick={() => void feed.refetch()}>
            <RefreshCw className="size-4" />
            {t("retry")}
          </Button>
        </div>
      )}
      {feed.isPending ? (
        <div
          aria-label={t("loading")}
          className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4"
        >
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="aspect-[1/1.25] animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : feed.data?.items.length ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-6 md:grid-cols-3 lg:grid-cols-4">
          {feed.data.items.map((item) => (
            <ExternalCollectionCard key={item.tokenId} item={item} />
          ))}
        </div>
      ) : (
        !unavailable && <p className="py-8 text-sm text-muted-foreground">{t("empty")}</p>
      )}
      <p className="text-xs text-muted-foreground">{t("collections.feeNotice")}</p>
    </div>
  );
}
