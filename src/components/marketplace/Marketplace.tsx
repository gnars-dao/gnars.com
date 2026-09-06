"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import {
  ArrowDown,
  ArrowUpRight,
  CircleAlert,
  LoaderCircle,
  RefreshCw,
  ShoppingBag,
} from "lucide-react";
import { formatEther } from "viem";
import { Button } from "@/components/ui/button";
import { ConnectButton } from "@/components/ui/ConnectButton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMarketplace, type MarketplaceView } from "@/hooks/use-marketplace";
import { useWriteAccount } from "@/hooks/use-write-account";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import type { MarketplaceItem, MarketplacePage } from "@/types/marketplace";
import { MarketplaceRecovery } from "./MarketplaceRecovery";
import { NftArtwork } from "./NftArtwork";

const MarketplaceDetail = dynamic(() => import("./MarketplaceDetail"), { ssr: false });
const views: MarketplaceView[] = ["catalogue", "listings", "owned"];

export function Marketplace({ initialPage }: { initialPage?: MarketplacePage }) {
  const t = useTranslations("marketplace");
  const [view, setView] = useState<MarketplaceView>("catalogue");
  const [selected, setSelected] = useState<MarketplaceItem | null>(null);
  const writer = useWriteAccount();
  const query = useMarketplace(
    view,
    view === "owned" ? writer?.account.address : undefined,
    initialPage,
  );
  const pages = query.data?.pages ?? [];
  const page = pages[0];
  const byToken = new Map<string, MarketplaceItem>();
  for (const item of pages.flatMap((p) => p.items)) {
    const previous = byToken.get(item.tokenId);
    byToken.set(item.tokenId, {
      ...item,
      offers: [
        ...new Map(
          [...(previous?.offers ?? []), ...item.offers].map((offer) => [offer.orderHash, offer]),
        ).values(),
      ],
    });
  }
  const items = [...byToken.values()];
  const disconnected = view === "owned" && !writer;
  const sourcesComplete = page?.sources.opensea.available && page?.sources.gnars.available;

  function changeView(next: MarketplaceView) {
    setView(next);
    setSelected(null);
  }

  return (
    <div className="py-8 md:py-10">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-5">
        <div>
          <div className="mb-3 flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <span className="size-2 rounded-full bg-blue-600" />
            {t("network")}
            <span aria-hidden="true">/</span>
            <span>{t("collection")}</span>
          </div>
          <h1 className="text-3xl font-bold md:text-4xl">{t("title")}</h1>
        </div>
        <Button variant="outline" onClick={() => changeView("owned")} className="cursor-pointer">
          <ShoppingBag className="size-4" />
          {t("sell")}
        </Button>
      </header>

      <MarketplaceRecovery />

      <div className="mb-6 flex items-center justify-between gap-3 border-b">
        <Tabs
          value={view}
          onValueChange={(value) => changeView(value as MarketplaceView)}
          className="min-w-0"
        >
          <TabsList
            aria-label={t("title")}
            className="h-auto max-w-full justify-start gap-4 overflow-x-auto rounded-none bg-transparent p-0"
          >
            {views.map((option) => (
              <TabsTrigger
                key={option}
                value={option}
                id={`market-tab-${option}`}
                aria-controls="market-panel"
                className="h-auto shrink-0 cursor-pointer rounded-none border-0 border-b-2 border-transparent px-0.5 py-3 text-sm font-medium text-muted-foreground data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none dark:data-[state=active]:bg-transparent"
              >
                {t(`views.${option}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("refresh")}
              disabled={query.isFetching || disconnected}
              onClick={() => void query.refetch()}
              className="mb-1 shrink-0 cursor-pointer"
            >
              <RefreshCw className={cn("size-4", query.isFetching && "animate-spin")} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("refresh")}</TooltipContent>
        </Tooltip>
      </div>

      <section id="market-panel" role="tabpanel" aria-labelledby={`market-tab-${view}`}>
        {!disconnected && page && (
          <div className="mb-5 space-y-2">
            {(["opensea", "gnars"] as const)
              .filter((source) => !page.sources[source].available)
              .map((source) => (
                <p
                  key={source}
                  role="status"
                  className="flex items-start gap-2 text-sm text-muted-foreground"
                >
                  <CircleAlert className="mt-0.5 size-4 shrink-0" />
                  {t("sourceUnavailable", { source: source === "opensea" ? "OpenSea" : "Gnars" })}
                </p>
              ))}
            {!page.sources.catalogue.available && (
              <p role="status" className="text-sm text-muted-foreground">
                {t("catalogueUnavailable")}
              </p>
            )}
          </div>
        )}

        {view === "owned" && writer && (
          <p className="mb-5 break-all text-xs text-muted-foreground">
            {t("wallet")}:{" "}
            <Link
              href={`/members/${writer.account.address}`}
              className="font-mono underline underline-offset-4"
            >
              {writer.account.address}
            </Link>
          </p>
        )}

        {disconnected ? (
          <div className="flex min-h-64 flex-col items-center justify-center gap-5 border-b">
            <ShoppingBag className="size-7 text-muted-foreground" />
            <h2 className="text-lg font-semibold">{t("connect")}</h2>
            <div className="w-48">
              <ConnectButton />
            </div>
          </div>
        ) : query.isPending ? (
          <div
            aria-label={t("loading")}
            className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4"
          >
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="aspect-[1/1.25] animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ) : query.isError && !page ? (
          <div role="alert" className="flex min-h-52 flex-col items-center justify-center gap-4">
            <p>{t("loadError")}</p>
            <Button variant="outline" onClick={() => void query.refetch()}>
              <RefreshCw className="size-4" />
              {t("retry")}
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="flex min-h-64 flex-col items-center justify-center gap-4 border-b text-center">
            <ShoppingBag className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {view !== "listings" && !page?.sources.catalogue.available
                ? t("loadError")
                : view === "owned"
                  ? t("emptyOwned")
                  : view === "catalogue"
                    ? t("emptyCatalogue")
                    : sourcesComplete
                      ? t("empty")
                      : t("availabilityUnknown")}
            </p>
            {view === "listings" && (
              <Button variant="outline" onClick={() => changeView("catalogue")}>
                {t("views.catalogue")}
                <ArrowUpRight className="size-4" />
              </Button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-x-4 gap-y-6 md:grid-cols-3 lg:grid-cols-4">
            {items.map((item) => {
              const best = [...item.offers].sort((a, b) =>
                BigInt(a.priceWei) < BigInt(b.priceWei)
                  ? -1
                  : BigInt(a.priceWei) > BigInt(b.priceWei)
                    ? 1
                    : 0,
              )[0];
              return (
                <button
                  key={item.tokenId}
                  onClick={() => setSelected(item)}
                  aria-label={t("details", { id: item.tokenId })}
                  className="group min-w-0 cursor-pointer overflow-hidden rounded-lg border text-left transition-colors hover:border-foreground/40 focus-visible:outline-2 focus-visible:outline-offset-4"
                >
                  <NftArtwork
                    item={item}
                    sizes="(max-width: 767px) 50vw, (max-width: 1023px) 33vw, 280px"
                  />
                  <div className="space-y-2 p-3 md:p-4">
                    <h2 className="truncate text-sm font-semibold">{item.name}</h2>
                    <div className="min-h-10">
                      {best ? (
                        <>
                          <p className="break-all font-mono text-sm font-semibold">
                            {formatEther(BigInt(best.priceWei))} ETH
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {best.source === "opensea" ? "OpenSea" : "Gnars"}
                          </p>
                        </>
                      ) : (
                        <p className="text-xs text-muted-foreground">{t("viewListings")}</p>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {query.isError && page && (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {t("loadError")}
          </p>
        )}
        {query.hasNextPage && (
          <div className="mt-8 flex justify-center">
            <Button
              variant="outline"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
              className="cursor-pointer"
            >
              {query.isFetchingNextPage ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <ArrowDown className="size-4" />
              )}
              {t("loadMore")}
            </Button>
          </div>
        )}
      </section>

      {selected && page && (
        <MarketplaceDetail
          key={`${selected.tokenId}-${writer?.account.address ?? "guest"}`}
          item={selected}
          capabilities={page.capabilities}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
