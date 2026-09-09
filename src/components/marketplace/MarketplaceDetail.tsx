"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  ShoppingBag,
  Tag,
  X,
} from "lucide-react";
import { formatEther } from "viem";
import { AddressDisplay } from "@/components/ui/address-display";
import { Button } from "@/components/ui/button";
import { ConnectButton } from "@/components/ui/ConnectButton";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useMarketplaceActions } from "@/hooks/use-marketplace-actions";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useWriteAccount } from "@/hooks/use-write-account";
import { Link } from "@/i18n/navigation";
import { DAO_ADDRESSES } from "@/lib/config";
import { parseMarketplacePrice } from "@/lib/marketplace-display";
import { cn } from "@/lib/utils";
import type {
  MarketplaceItem,
  MarketplaceOffer,
  MarketplacePage,
  MarketplaceSource,
} from "@/types/marketplace";
import { MarketplaceModeration } from "./MarketplaceModeration";
import { MarketplaceRecovery } from "./MarketplaceRecovery";
import { MarketplaceSourceLogo } from "./MarketplaceSourceLogo";
import { NftArtwork } from "./NftArtwork";

type Mode = "details" | "buy" | "sell" | "cancel";

export default function MarketplaceDetail({
  item: initialItem,
  capabilities: initialCapabilities,
  restoreFocus,
  onClose,
}: {
  item: MarketplaceItem;
  capabilities: MarketplacePage["capabilities"];
  restoreFocus: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("marketplace");
  const locale = useLocale();
  const writer = useWriteAccount();
  const actions = useMarketplaceActions();
  const queryClient = useQueryClient();
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(true);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => setMounted(true), []);
  const [mode, setMode] = useState<Mode>("details");
  const [offer, setOffer] = useState<MarketplaceOffer | null>(null);
  const [price, setPrice] = useState("");
  const [duration, setDuration] = useState(7);
  const [listingDestination, setListingDestination] = useState<MarketplaceSource>(
    initialCapabilities.customTrading
      ? "gnars-contract"
      : initialCapabilities.openseaSell
        ? "opensea"
        : "gnars",
  );
  const [submitted, setSubmitted] = useState(false);
  const [priceTouched, setPriceTouched] = useState(false);
  const [quotePrice, setQuotePrice] = useState("");
  const community =
    !!initialItem.collectionAddress &&
    initialItem.collectionAddress.toLowerCase() !== DAO_ADDRESSES.token.toLowerCase();
  const collectionAddress = initialItem.collectionAddress ?? DAO_ADDRESSES.token;
  const detail = useQuery({
    queryKey: ["marketplace", "detail", collectionAddress, initialItem.tokenId],
    queryFn: async ({ signal }): Promise<MarketplacePage> => {
      const path = community
        ? `/api/marketplace/community/nfts/${collectionAddress}/${initialItem.tokenId}`
        : `/api/marketplace/nfts/${initialItem.tokenId}`;
      const response = await fetch(path, { signal });
      if (!response.ok) throw new Error("NFT unavailable");
      return response.json();
    },
    staleTime: 0,
    retry: 1,
  });
  const item = detail.data?.items[0] ?? initialItem;
  const capabilities = detail.data?.capabilities ?? initialCapabilities;
  const nativeTrading = (source: MarketplaceSource) =>
    source === "gnars-contract" ? !!capabilities.customTrading : capabilities.localTrading;
  const sourceName = (source: MarketplaceSource) =>
    source === "opensea" ? "OpenSea" : source === "gnars" ? "Seaport" : t("customContract");
  const destinations = (["gnars-contract", "opensea", "gnars"] as const).filter((source) =>
    source === "opensea" ? capabilities.openseaSell : nativeTrading(source),
  );
  const isOwner = !!writer && item.owner?.toLowerCase() === writer.account.address.toLowerCase();
  const priceWei = parseMarketplacePrice(price);
  useEffect(() => {
    const timer = setTimeout(() => setQuotePrice(price), 400);
    return () => clearTimeout(timer);
  }, [price]);
  const quote = useQuery({
    queryKey: [
      "marketplace",
      "quote",
      writer?.account.address,
      item.tokenId,
      quotePrice,
      listingDestination,
    ],
    queryFn: () =>
      actions.quote({
        tokenId: item.tokenId,
        priceEth: formatEther(parseMarketplacePrice(quotePrice)!),
        source: listingDestination,
      }),
    enabled: mode === "sell" && !!writer && !!parseMarketplacePrice(quotePrice),
    staleTime: 15_000,
    retry: false,
  });
  const verifiedDetail =
    detail.data?.ownershipVerified === true && !detail.isError && !detail.isFetching;
  const busy = actions.isBusy;
  const success = actions.phase === "complete";
  const unresolved =
    !!actions.invalidJournal ||
    actions.canCancelSavedListing ||
    actions.canResume ||
    ["pending", "unknown", "confirming", "signing", "saving"].includes(actions.phase);
  const quoteReady =
    quote.data?.priceWei === priceWei?.toString() &&
    quote.data?.source === listingDestination &&
    !quote.isFetching &&
    !quote.isError;
  const canList =
    listingDestination === "opensea" ? capabilities.openseaSell : nativeTrading(listingDestination);

  async function execute() {
    setSubmitted(true);
    if (mode === "sell" && (!priceWei || !quoteReady)) return;
    if (mode === "sell")
      await actions.list({
        tokenId: item.tokenId,
        priceEth: formatEther(priceWei!),
        durationDays: duration,
        expectedRoyaltyWei: quote.data!.royaltyWei,
        expectedQuote: quote.data!,
        source: listingDestination,
      });
    else if (mode === "buy" && offer) await actions.buy({ tokenId: item.tokenId, offer });
    else if (mode === "cancel" && offer) await actions.cancel(offer, item.tokenId);
    void queryClient.invalidateQueries({ queryKey: ["marketplace"] });
  }

  async function choose(next: Mode, listing?: MarketplaceOffer) {
    if (busy || unresolved) return;
    if (writer) await actions.reset();
    setSubmitted(false);
    setPriceTouched(false);
    setOffer(listing ?? null);
    setMode(next);
    if (next === "sell") setListingDestination(destinations[0] ?? "gnars");
    scrollRef.current?.scrollTo({ top: 0 });
  }

  if (!mounted) return null;

  return (
    <Drawer
      open={open}
      direction={isDesktop ? "right" : "bottom"}
      dismissible={!busy}
      autoFocus
      fixed
      onOpenChange={(nextOpen) => {
        if (!busy) setOpen(nextOpen);
      }}
      onAnimationEnd={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <DrawerContent
        className="overflow-hidden shadow-2xl data-[vaul-drawer-direction=bottom]:mt-0 data-[vaul-drawer-direction=bottom]:h-[92dvh] data-[vaul-drawer-direction=bottom]:max-h-[92dvh] data-[vaul-drawer-direction=right]:w-[min(560px,100vw)] data-[vaul-drawer-direction=right]:sm:max-w-[560px] motion-reduce:!animate-none motion-reduce:!transition-none"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          titleRef.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DrawerHeader className="shrink-0 flex-row items-center justify-between gap-4 border-b px-5 py-4 text-left md:px-6 md:py-5 group-data-[vaul-drawer-direction=bottom]/drawer-content:text-left">
          <div className="flex min-w-0 items-center gap-3">
            {mode !== "details" && !busy && !success && !unresolved && (
              <Button
                size="icon"
                variant="ghost"
                aria-label={t("back")}
                onClick={() => choose("details")}
                className="shrink-0"
              >
                <ArrowLeft className="size-4" />
              </Button>
            )}
            <div className="min-w-0 space-y-1">
              <DrawerTitle
                ref={titleRef}
                tabIndex={-1}
                className="break-words text-xl font-semibold outline-none"
              >
                {item.name}
              </DrawerTitle>
              <DrawerDescription className="flex items-center gap-2 text-xs">
                {item.collectionName ?? t("collection")}
                <span aria-hidden="true" className="text-border">
                  /
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-blue-600" />
                  {t("network")}
                </span>
              </DrawerDescription>
            </div>
          </div>
          <DrawerClose asChild>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("close")}
              disabled={busy}
              className="shrink-0 cursor-pointer"
            >
              <X className="size-4" />
            </Button>
          </DrawerClose>
        </DrawerHeader>
        <div
          ref={scrollRef}
          data-vaul-no-drag
          className="min-h-0 flex-1 select-text space-y-6 overflow-y-auto overscroll-contain px-5 pt-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] md:px-6 md:pt-6"
        >
          {mode === "details" && <MarketplaceRecovery />}
          <div className="min-w-0 space-y-3">
            <div
              className={cn(
                "mx-auto overflow-hidden rounded-lg",
                mode === "details" ? "w-[min(100%,36dvh)] md:w-full" : "w-24",
              )}
            >
              <NftArtwork key={item.image} item={item} sizes="(max-width: 767px) 36vh, 512px" />
            </div>
            <a
              href={`https://opensea.io/item/base/${collectionAddress}/${item.tokenId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex w-fit items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              {t("openSea")}
              <ExternalLink className="size-3" />
            </a>
          </div>
          <div className="min-w-0 space-y-5">
            {mode === "details" ? (
              <>
                <div className="flex items-center justify-between gap-3 border-b pb-4 text-xs">
                  <span className="text-muted-foreground">{t("tokenId")}</span>
                  <span className="font-mono">#{item.tokenId}</span>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{t("owner")}</p>
                  {item.owner ? (
                    <Link
                      href={`/members/${item.owner}`}
                      prefetch={false}
                      title={item.owner}
                      className="mt-2 block w-fit max-w-full rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <AddressDisplay
                        key={item.owner}
                        address={item.owner}
                        variant="compact"
                        avatarSize="sm"
                        showCopy={false}
                        showExplorer={false}
                        onAddressClick={() => {}}
                        className="max-w-full min-w-0 [&>span.font-mono]:min-w-0 [&>span.font-mono]:break-all"
                      />
                    </Link>
                  ) : (
                    <span className="text-sm">{t("availabilityUnknown")}</span>
                  )}
                  {!verifiedDetail && !detail.isFetching && !detail.isError && (
                    <div className="mt-3 space-y-2">
                      <p role="status" className="text-xs text-muted-foreground">
                        {t("ownershipUnverified")}
                      </p>
                      <Button size="sm" variant="outline" onClick={() => void detail.refetch()}>
                        <RefreshCw className="size-4" />
                        {t("retryVerification")}
                      </Button>
                    </div>
                  )}
                </div>
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold">{t("offers")}</h3>
                  {detail.isPending ? (
                    <LoaderCircle className="size-4 animate-spin" aria-label={t("loading")} />
                  ) : detail.isError ? (
                    <div className="space-y-2">
                      <p role="alert" className="text-sm text-destructive">
                        {t("loadError")}
                      </p>
                      <Button size="sm" variant="outline" onClick={() => void detail.refetch()}>
                        <RefreshCw className="size-4" />
                        {t("retry")}
                      </Button>
                    </div>
                  ) : item.offers.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {t(
                        detail.data &&
                          Object.values(detail.data.sources).every(
                            (source) =>
                              (source.available && !source.partial) ||
                              source.error === "not_configured",
                          )
                          ? "notListed"
                          : "availabilityUnknown",
                      )}
                    </p>
                  ) : null}
                  {item.offers.map((listing) => (
                    <div key={listing.id} className="space-y-3 border-b py-2 pb-4 last:border-b-0">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="break-all font-mono text-xl font-semibold">
                          {formatEther(BigInt(listing.priceWei))} ETH
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {sourceName(listing.source)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {t("expires")}:{" "}
                        {new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
                          listing.expiresAt * 1000,
                        )}
                      </p>
                      {writer &&
                      listing.seller.toLowerCase() === writer.account.address.toLowerCase() ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => choose("cancel", listing)}
                          disabled={
                            busy ||
                            unresolved ||
                            !verifiedDetail ||
                            !(listing.source === "opensea"
                              ? capabilities.openseaCancel
                              : nativeTrading(listing.source))
                          }
                          className="w-full cursor-pointer"
                        >
                          <X className="size-3.5" />
                          {t("cancel")}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          onClick={() => choose("buy", listing)}
                          disabled={
                            busy ||
                            unresolved ||
                            !verifiedDetail ||
                            !(listing.source === "opensea"
                              ? capabilities.openseaBuy
                              : nativeTrading(listing.source))
                          }
                          className="w-full cursor-pointer"
                        >
                          <ShoppingBag className="size-3.5" />
                          {t("buy")}
                        </Button>
                      )}
                      {community && (
                        <MarketplaceModeration
                          key={`${listing.orderHash}:${listing.moderation?.revision}`}
                          offer={listing}
                        />
                      )}
                    </div>
                  ))}
                </div>
                {!writer ? (
                  <ConnectButton />
                ) : isOwner && !community ? (
                  <div className="space-y-2">
                    <Button
                      variant="default"
                      onClick={() => choose("sell")}
                      disabled={busy || unresolved || !verifiedDetail || destinations.length === 0}
                      className="w-full cursor-pointer"
                    >
                      <Tag className="size-4" />
                      {t("sell")}
                    </Button>
                    {destinations.length === 0 && (
                      <p role="status" className="text-xs text-muted-foreground">
                        {t("listingUnavailable")}
                      </p>
                    )}
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <h3 className="text-base font-semibold">
                  {t(mode === "sell" ? "sell" : mode === "cancel" ? "cancel" : "buy")}
                </h3>
                {mode === "sell" ? (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="market-destination">{t("source")}</Label>
                      {destinations.length > 1 ? (
                        <Select
                          value={listingDestination}
                          onValueChange={(value) =>
                            setListingDestination(value as MarketplaceSource)
                          }
                          disabled={busy || success || unresolved}
                        >
                          <SelectTrigger
                            id="market-destination"
                            className="h-11 w-full cursor-pointer"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {destinations.map((source) => (
                              <SelectItem
                                key={source}
                                value={source}
                                className="cursor-pointer py-3"
                              >
                                <MarketplaceSourceLogo source={source} />
                                {sourceName(source)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <p
                          id="market-destination"
                          className="flex items-center gap-2 text-sm font-medium"
                        >
                          <MarketplaceSourceLogo source={listingDestination} />
                          {sourceName(listingDestination)}
                        </p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="market-price">{t("price")}</Label>
                      <Input
                        id="market-price"
                        inputMode="decimal"
                        autoComplete="off"
                        value={price}
                        placeholder="0.01"
                        onChange={(event) => setPrice(event.target.value)}
                        onBlur={() => setPriceTouched(true)}
                        disabled={busy || success || unresolved}
                        aria-invalid={(submitted || priceTouched) && !priceWei}
                      />
                      {(submitted || priceTouched) && !priceWei && (
                        <p role="alert" className="text-xs text-destructive">
                          {t("invalidPrice")}
                        </p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="market-duration">{t("duration")}</Label>
                      <select
                        id="market-duration"
                        value={duration}
                        onChange={(event) => setDuration(Number(event.target.value))}
                        disabled={busy || success || unresolved}
                        className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                      >
                        {[1, 7, 30].map((days) => (
                          <option key={days} value={days}>
                            {t("days", { count: days })}
                          </option>
                        ))}
                      </select>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t(listingDestination === "opensea" ? "openSeaFeeNote" : "royaltyNote")}
                    </p>
                    {quoteReady && quote.data ? (
                      <dl className="space-y-2 text-xs">
                        <div className="flex flex-wrap justify-between gap-2">
                          <dt className="text-muted-foreground">
                            {t(listingDestination === "opensea" ? "openSeaFees" : "royalties")}
                          </dt>
                          <dd className="break-all font-mono">
                            {formatEther(
                              listingDestination === "opensea"
                                ? quote.data.fees.reduce(
                                    (sum, fee) => sum + BigInt(fee.amountWei),
                                    0n,
                                  )
                                : BigInt(quote.data.royaltyWei),
                            )}{" "}
                            ETH
                          </dd>
                        </div>
                      </dl>
                    ) : quote.isFetching ? (
                      <LoaderCircle className="size-4 animate-spin" aria-label={t("loading")} />
                    ) : quote.isError ? (
                      <div className="space-y-2">
                        <p role="alert" className="text-xs text-destructive">
                          {t("quoteError")}
                        </p>
                        <Button size="sm" variant="outline" onClick={() => void quote.refetch()}>
                          <RefreshCw className="size-4" />
                          {t("retry")}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  offer && (
                    <dl className="space-y-3 text-sm">
                      {mode === "cancel" && (
                        <div>
                          <dt className="text-xs text-muted-foreground">{t("total")}</dt>
                          <dd className="mt-1 break-all font-mono font-semibold">
                            {formatEther(BigInt(offer.priceWei))} ETH
                          </dd>
                        </div>
                      )}
                      <div>
                        <dt className="text-xs text-muted-foreground">{t("seller")}</dt>
                        <dd className="mt-1 break-all font-mono text-xs">
                          <Link
                            href={`/members/${offer.seller}`}
                            className="underline underline-offset-4"
                          >
                            {offer.seller}
                          </Link>
                        </dd>
                      </div>
                    </dl>
                  )
                )}
                {mode === "cancel" && (
                  <p className="text-sm text-muted-foreground">{t("cancelConfirm")}</p>
                )}
                <p className="text-xs text-muted-foreground">{t("gas")}</p>
              </>
            )}
          </div>
        </div>
        {mode !== "details" && (
          <footer className="shrink-0 space-y-3 border-t bg-background px-5 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-6">
            <div className="max-h-[35dvh] overflow-y-auto">
              <MarketplaceRecovery showCompleted />
            </div>
            {!success && !unresolved && !busy && mode !== "cancel" && (
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  {t(mode === "sell" ? "proceeds" : "total")}
                </span>
                <span className="break-all font-mono text-lg font-semibold tabular-nums">
                  {mode === "sell"
                    ? quoteReady && quote.data
                      ? `${formatEther(BigInt(quote.data.sellerWei))} ETH`
                      : "-"
                    : offer
                      ? `${formatEther(BigInt(offer.priceWei))} ETH`
                      : "-"}
                </span>
              </div>
            )}
            {!verifiedDetail && !detail.isFetching && !unresolved && (
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                onClick={() => void detail.refetch()}
              >
                <RefreshCw className="size-4" />
                {t("retryVerification")}
              </Button>
            )}
            {!writer ? (
              <ConnectButton />
            ) : success ? (
              <DrawerClose asChild>
                <Button className="h-11 w-full">{t("newAction")}</Button>
              </DrawerClose>
            ) : (
              !unresolved && (
                <Button
                  disabled={
                    busy ||
                    (mode === "sell" && !quoteReady) ||
                    !verifiedDetail ||
                    (mode === "sell"
                      ? !canList
                      : offer?.source === "opensea"
                        ? !(mode === "cancel"
                            ? capabilities.openseaCancel
                            : capabilities.openseaBuy)
                        : !nativeTrading(offer?.source ?? "gnars"))
                  }
                  onClick={() => void execute()}
                  variant={mode === "cancel" ? "destructive" : "default"}
                  className="h-11 w-full cursor-pointer"
                >
                  {busy ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : mode === "sell" ? (
                    <Tag className="size-4" />
                  ) : mode === "buy" ? (
                    <ShoppingBag className="size-4" />
                  ) : (
                    <X className="size-4" />
                  )}
                  {t(
                    mode === "sell"
                      ? "confirmList"
                      : mode === "buy"
                        ? "confirmBuy"
                        : "confirmCancel",
                  )}
                </Button>
              )
            )}
          </footer>
        )}
      </DrawerContent>
    </Drawer>
  );
}
