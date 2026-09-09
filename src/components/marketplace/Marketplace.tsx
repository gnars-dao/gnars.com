"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  CircleAlert,
  LoaderCircle,
  RefreshCw,
  Search,
  ShoppingBag,
  X,
} from "lucide-react";
import { isAddress, type Address } from "viem";
import { Button } from "@/components/ui/button";
import { ConnectButton } from "@/components/ui/ConnectButton";
import Image from "@/components/ui/content-image";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMarketplace, type MarketplaceView } from "@/hooks/use-marketplace";
import { useWriteAccount } from "@/hooks/use-write-account";
import { Link } from "@/i18n/navigation";
import { DAO_ADDRESSES } from "@/lib/config";
import { cn } from "@/lib/utils";
import type { MarketplaceItem, MarketplacePage } from "@/types/marketplace";
import { CommunitySellerListings } from "./CommunitySellerListings";
import { MarketplaceCard } from "./MarketplaceCard";
import { MarketplaceModerationQueue } from "./MarketplaceModeration";
import { MarketplaceRecovery } from "./MarketplaceRecovery";
import { MarketplaceSaleBands } from "./MarketplaceSaleBands";

const MarketplaceDetail = dynamic(() => import("./MarketplaceDetail"), { ssr: false });
const CommunitySubmission = dynamic(
  () => import("./CommunitySubmission").then((mod) => mod.CommunitySubmission),
  { ssr: false },
);
const views: MarketplaceView[] = ["listings", "catalogue", "owned", "selling"];

export function Marketplace({ initialPage }: { initialPage?: MarketplacePage }) {
  const t = useTranslations("marketplace");
  const [view, setView] = useState<MarketplaceView>("listings");
  const [selected, setSelected] = useState<MarketplaceItem | null>(null);
  const [search, setSearch] = useState("");
  const [tokenId, setTokenId] = useState<string | undefined>();
  const [searchInvalid, setSearchInvalid] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedCollection, setSelectedCollection] = useState<Address | null>(null);
  const [submissionOpen, setSubmissionOpen] = useState(false);
  const queryClient = useQueryClient();
  const [urlReady, setUrlReady] = useState(false);
  const selectedTrigger = useRef<HTMLButtonElement | null>(null);
  const writer = useWriteAccount();
  const query = useMarketplace(
    view,
    view === "owned" || view === "selling" ? writer?.account.address : undefined,
    initialPage,
    { tokenId },
  );
  const pages = query.data?.pages ?? [];
  const page = pages[0];
  const sharedItem = useQuery({
    queryKey: ["marketplace", "detail", selectedCollection ?? DAO_ADDRESSES.token, selectedId],
    enabled: !!selectedId && !selected,
    queryFn: async ({ signal }): Promise<MarketplacePage> => {
      const path =
        selectedCollection && selectedCollection.toLowerCase() !== DAO_ADDRESSES.token.toLowerCase()
          ? `/api/marketplace/community/nfts/${selectedCollection}/${selectedId}`
          : `/api/marketplace/nfts/${selectedId}`;
      const response = await fetch(path, { signal });
      if (!response.ok) throw new Error("NFT unavailable");
      return response.json();
    },
    staleTime: 30_000,
    retry: 1,
  });
  useEffect(() => {
    const restore = () => {
      const params = new URLSearchParams(window.location.search);
      const restoredView = params.get("view");
      const restoredId = params.get("q");
      const restoredSelection = params.get("nft");
      const restoredCollection = params.get("collection");
      setSelectedCollection(
        restoredCollection && isAddress(restoredCollection) ? restoredCollection : null,
      );
      setView(
        views.includes(restoredView as MarketplaceView)
          ? (restoredView as MarketplaceView)
          : "listings",
      );
      setTokenId(
        restoredId && /^\d{1,20}$/.test(restoredId) ? BigInt(restoredId).toString() : undefined,
      );
      setSearch(restoredId && /^\d{1,20}$/.test(restoredId) ? BigInt(restoredId).toString() : "");
      setSelectedId(
        restoredSelection &&
          /^\d{1,78}$/.test(restoredSelection) &&
          BigInt(restoredSelection) < 2n ** 256n
          ? BigInt(restoredSelection).toString()
          : null,
      );
      setSelected(null);
      setUrlReady(true);
    };
    restore();
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  useEffect(() => {
    if (!urlReady) return;
    const url = new URL(window.location.href);
    if (view === "listings") url.searchParams.delete("view");
    else url.searchParams.set("view", view);
    if (tokenId) url.searchParams.set("q", tokenId);
    else url.searchParams.delete("q");
    if (selectedId) url.searchParams.set("nft", selectedId);
    else url.searchParams.delete("nft");
    if (selectedId && selectedCollection) url.searchParams.set("collection", selectedCollection);
    else url.searchParams.delete("collection");
    window.history.replaceState(window.history.state, "", url);
  }, [view, tokenId, selectedId, selectedCollection, urlReady]);
  useEffect(() => {
    const restored = sharedItem.data?.items.find((item) => item.tokenId === selectedId);
    if (!selected && restored) setSelected(restored);
  }, [sharedItem.data, selectedId, selected]);
  const byToken = new Map<string, MarketplaceItem>();
  for (const item of pages.flatMap((p) => p.items)) {
    const previous = byToken.get(item.tokenId);
    byToken.set(item.tokenId, {
      ...item,
      offers: [
        ...new Map(
          [...(previous?.offers ?? []), ...item.offers].map((offer) => [
            `${offer.source}:${offer.protocolAddress.toLowerCase()}:${offer.orderHash.toLowerCase()}`,
            offer,
          ]),
        ).values(),
      ],
    });
  }
  const items = [...byToken.values()];
  const disconnected = (view === "owned" || view === "selling") && !writer;
  const sourcesComplete =
    pages.length > 0 &&
    pages.every((current) =>
      [current.sources.opensea, current.sources.gnars, current.sources["gnars-contract"]].every(
        (source) =>
          !source || (source.available && !source.partial) || source.error === "not_configured",
      ),
    );

  function changeView(next: MarketplaceView) {
    setView(next);
    setSelected(null);
    setSelectedId(null);
    setSelectedCollection(null);
    setSearch("");
    setTokenId(undefined);
    setSearchInvalid(false);
  }

  function findToken(event: FormEvent) {
    event.preventDefault();
    const value = search.trim().replace(/^#/, "");
    if (!value) {
      setTokenId(undefined);
      setSearchInvalid(false);
      return;
    }
    if (!/^\d{1,20}$/.test(value)) {
      setSearchInvalid(true);
      return;
    }
    setSearchInvalid(false);
    setView("catalogue");
    setTokenId(BigInt(value).toString());
  }

  return (
    <div className="py-8 md:py-10">
      <header className="mb-7 flex flex-wrap items-center justify-between gap-5">
        <div className="flex min-w-0 items-center gap-4">
          <Image
            src="/gnars.webp"
            alt=""
            width={64}
            height={64}
            className="size-14 shrink-0 rounded-lg object-contain md:size-16"
          />
          <div className="min-w-0">
            <div className="mb-3 flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <span className="size-2 rounded-full bg-blue-600" />
              {t("network")}
              <span aria-hidden="true">/</span>
              <span>{t("collection")}</span>
            </div>
            <h1 className="text-2xl font-bold md:text-3xl">{t("title")}</h1>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={!urlReady}
            onClick={() => setSubmissionOpen(true)}
            className="cursor-pointer"
          >
            <ShoppingBag className="size-4" />
            {t("community.submit")}
          </Button>
          <Button
            variant="outline"
            disabled={!urlReady}
            onClick={() => changeView("owned")}
            className="cursor-pointer"
          >
            <ShoppingBag className="size-4" />
            {t("sell")}
          </Button>
        </div>
      </header>

      {!selected && <MarketplaceRecovery />}

      <div className="mb-6 flex items-center justify-between gap-3 border-b">
        <Tabs
          value={view}
          onValueChange={(value) => changeView(value as MarketplaceView)}
          className="min-w-0"
        >
          <TabsList
            aria-label={t("title")}
            className="h-auto max-w-full justify-start gap-3 overflow-x-auto rounded-none bg-transparent p-0 sm:gap-4"
          >
            {views.map((option) => (
              <TabsTrigger
                key={option}
                value={option}
                disabled={!urlReady}
                id={`market-tab-${option}`}
                aria-controls="market-panel"
                className="h-auto min-h-11 shrink-0 cursor-pointer rounded-none border-0 border-b-2 border-transparent px-0.5 py-3 text-xs font-medium text-muted-foreground data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none sm:text-sm dark:data-[state=active]:bg-transparent"
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
              disabled={!urlReady || query.isFetching || disconnected}
              onClick={() => {
                void query.refetch();
                void queryClient.invalidateQueries({ queryKey: ["marketplace", "community"] });
              }}
              className="mb-1 shrink-0 cursor-pointer"
            >
              <RefreshCw className={cn("size-4", query.isFetching && "animate-spin")} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("refresh")}</TooltipContent>
        </Tooltip>
      </div>

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <form onSubmit={findToken} className="w-full max-w-sm">
          <div className="relative flex items-center">
            <Search className="pointer-events-none absolute left-3 size-4 text-muted-foreground" />
            <Input
              aria-label={t("search")}
              aria-invalid={searchInvalid}
              disabled={!urlReady}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setSearchInvalid(false);
              }}
              placeholder={t("search")}
              inputMode="numeric"
              className="h-10 pr-20 pl-9"
            />
            <div className="absolute right-1 flex items-center gap-1">
              {(search || tokenId) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={t("clearSearch")}
                  onClick={() => {
                    setSearch("");
                    setTokenId(undefined);
                    setSearchInvalid(false);
                  }}
                >
                  <X className="size-3.5" />
                </Button>
              )}
              <Button
                type="submit"
                disabled={!urlReady}
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={t("findToken")}
              >
                <Search className="size-4" />
              </Button>
            </div>
          </div>
          {searchInvalid && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {t("invalidSearch")}
            </p>
          )}
        </form>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {tokenId ? t("exactResult", { id: tokenId }) : t(`ordering.${view}`)}
        </div>
      </div>
      {selectedId && !selected && sharedItem.isPending && (
        <p role="status" className="mb-4 text-sm text-muted-foreground">
          {t("loading")}
        </p>
      )}
      {selectedId &&
        !selected &&
        (sharedItem.isError || (sharedItem.data && !sharedItem.data.items.length)) && (
          <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 text-sm">
            <span>{t("loadError")}</span>
            <Button size="sm" variant="outline" onClick={() => void sharedItem.refetch()}>
              <RefreshCw className="size-4" />
              {t("retry")}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("close")}
              onClick={() => setSelectedId(null)}
            >
              <X className="size-4" />
            </Button>
          </div>
        )}

      <section id="market-panel" role="tabpanel" aria-labelledby={`market-tab-${view}`}>
        {!disconnected && page && (
          <div className="mb-5 space-y-2">
            {(["opensea", "gnars", "gnars-contract"] as const)
              .filter((source) =>
                pages.some((current) => {
                  const availability = current.sources[source];
                  return (
                    availability &&
                    (!availability.available || availability.partial) &&
                    availability.error !== "not_configured"
                  );
                }),
              )
              .map((source) => (
                <p
                  key={source}
                  role="status"
                  className="flex items-start gap-2 text-sm text-muted-foreground"
                >
                  <CircleAlert className="mt-0.5 size-4 shrink-0" />
                  {t("sourceUnavailable", { source: t(`sourceNames.${source}`) })}
                </p>
              ))}
            {!page.sources.catalogue.available && (
              <p role="status" className="text-sm text-muted-foreground">
                {t("catalogueUnavailable")}
              </p>
            )}
          </div>
        )}

        {(view === "owned" || view === "selling") && writer && (
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
        ) : view === "listings" ? (
          <MarketplaceSaleBands
            items={items}
            pending={query.isPending}
            failed={query.isError}
            complete={sourcesComplete}
            onRetry={() => void query.refetch()}
            onSelect={(item, event) => {
              selectedTrigger.current = event.currentTarget;
              setSelected(item);
              setSelectedId(item.tokenId);
              setSelectedCollection(item.collectionAddress ?? null);
            }}
          />
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
              {tokenId && page?.sources.catalogue.available
                ? t("tokenNotFound", { id: tokenId })
                : view !== "selling" && !page?.sources.catalogue.available
                  ? t("loadError")
                  : view === "owned"
                    ? t("emptyOwned")
                    : view === "catalogue"
                      ? t("emptyCatalogue")
                      : sourcesComplete
                        ? t("empty")
                        : t("availabilityUnknown")}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-x-4 gap-y-6 md:grid-cols-3 lg:grid-cols-4">
            {items.map((item) => (
              <MarketplaceCard
                key={item.tokenId}
                item={item}
                view={view}
                sourcesComplete={sourcesComplete}
                exactSearch={!!tokenId}
                onClick={(event) => {
                  selectedTrigger.current = event.currentTarget;
                  setSelected(item);
                  setSelectedId(item.tokenId);
                  setSelectedCollection(item.collectionAddress ?? null);
                }}
              />
            ))}
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
      {view === "selling" && <CommunitySellerListings />}
      <MarketplaceModerationQueue />

      {submissionOpen && (
        <CommunitySubmission
          open={submissionOpen}
          onClose={() => setSubmissionOpen(false)}
          onPublished={() => {
            void queryClient.invalidateQueries({ queryKey: ["marketplace"] });
          }}
        />
      )}
      {selected && (
        <MarketplaceDetail
          key={`${selectedCollection ?? DAO_ADDRESSES.token}-${selected.tokenId}-${writer?.account.address ?? "guest"}`}
          item={selected}
          capabilities={
            (page ?? sharedItem.data)?.capabilities ?? {
              openseaBuy: false,
              openseaSell: false,
              openseaCancel: false,
              localTrading: false,
              customTrading: false,
            }
          }
          restoreFocus={() => {
            if (selectedTrigger.current?.isConnected) {
              selectedTrigger.current.focus({ preventScroll: true });
            }
          }}
          onClose={() => {
            setSelected(null);
            setSelectedId(null);
            setSelectedCollection(null);
          }}
        />
      )}
    </div>
  );
}
