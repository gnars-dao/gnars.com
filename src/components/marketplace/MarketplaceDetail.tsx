"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  ShoppingBag,
  Tag,
  X,
} from "lucide-react";
import { formatEther } from "viem";
import { Button } from "@/components/ui/button";
import { ConnectButton } from "@/components/ui/ConnectButton";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMarketplaceActions } from "@/hooks/use-marketplace-actions";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useWriteAccount } from "@/hooks/use-write-account";
import { Link } from "@/i18n/navigation";
import { DAO_ADDRESSES } from "@/lib/config";
import { parseMarketplacePrice } from "@/lib/marketplace-display";
import { cn } from "@/lib/utils";
import type { MarketplaceItem, MarketplaceOffer, MarketplacePage } from "@/types/marketplace";
import { MarketplaceRecovery } from "./MarketplaceRecovery";
import { NftArtwork } from "./NftArtwork";

type Mode = "details" | "buy" | "sell" | "cancel";
const phases = [
  "idle",
  "checking",
  "approving",
  "signing",
  "saving",
  "buying",
  "cancelling",
  "confirming",
  "success",
  "error",
] as const;

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
  const [submitted, setSubmitted] = useState(false);
  const [quotePrice, setQuotePrice] = useState("");
  const detail = useQuery({
    queryKey: ["marketplace", "detail", initialItem.tokenId],
    queryFn: async ({ signal }): Promise<MarketplacePage> => {
      const response = await fetch(`/api/marketplace/nfts/${initialItem.tokenId}`, { signal });
      if (!response.ok) throw new Error("NFT unavailable");
      return response.json();
    },
    staleTime: 0,
    retry: 1,
  });
  const item = detail.data?.items[0] ?? initialItem;
  const capabilities = detail.data?.capabilities ?? initialCapabilities;
  const isOwner = !!writer && item.owner?.toLowerCase() === writer.account.address.toLowerCase();
  const priceWei = parseMarketplacePrice(price);
  useEffect(() => {
    const timer = setTimeout(() => setQuotePrice(price), 400);
    return () => clearTimeout(timer);
  }, [price]);
  const quote = useQuery({
    queryKey: ["marketplace", "quote", writer?.account.address, item.tokenId, quotePrice],
    queryFn: () =>
      actions.quote({
        tokenId: item.tokenId,
        priceEth: formatEther(parseMarketplacePrice(quotePrice)!),
      }),
    enabled: mode === "sell" && !!writer && !!parseMarketplacePrice(quotePrice),
    staleTime: 15_000,
    retry: false,
  });
  const verifiedDetail =
    !!detail.data?.sources.catalogue.available && !detail.isError && !detail.isFetching;
  const phase =
    actions.phase === "complete"
      ? "success"
      : actions.phase === "failed"
        ? "error"
        : (phases.find((value) => value === actions.phase) ?? "checking");
  const busy = actions.isBusy;
  const success = phase === "success";
  const unresolved = ["pending", "unknown", "confirming", "signing", "saving"].includes(
    actions.phase,
  );
  const quoteReady =
    quote.data?.priceWei === priceWei?.toString() && !quote.isFetching && !quote.isError;

  async function execute() {
    setSubmitted(true);
    if (mode === "sell" && (!priceWei || !quoteReady)) return;
    if (mode === "sell")
      await actions.list({
        tokenId: item.tokenId,
        priceEth: formatEther(priceWei!),
        durationDays: duration,
        expectedRoyaltyWei: quote.data!.royaltyWei,
      });
    else if (mode === "buy" && offer) await actions.buy({ tokenId: item.tokenId, offer });
    else if (mode === "cancel" && offer) await actions.cancel(offer);
    void queryClient.invalidateQueries({ queryKey: ["marketplace"] });
  }

  function choose(next: Mode, listing?: MarketplaceOffer) {
    if (busy || unresolved) return;
    if (writer) actions.reset();
    setSubmitted(false);
    setOffer(listing ?? null);
    setMode(next);
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
                {t("collection")}
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
          <Button
            size="icon"
            variant="ghost"
            aria-label={t("close")}
            onClick={() => setOpen(false)}
            disabled={busy}
            className="shrink-0 cursor-pointer"
          >
            <X className="size-4" />
          </Button>
        </DrawerHeader>
        <div
          ref={scrollRef}
          data-vaul-no-drag
          className="min-h-0 flex-1 select-text space-y-6 overflow-y-auto overscroll-contain px-5 pt-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] md:px-6 md:pt-6"
        >
          <MarketplaceRecovery />
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
              href={`https://opensea.io/item/base/${DAO_ADDRESSES.token}/${item.tokenId}`}
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
                <div>
                  <p className="text-xs text-muted-foreground">{t("owner")}</p>
                  {item.owner ? (
                    <Link
                      href={`/members/${item.owner}`}
                      className="mt-1 block break-all font-mono text-xs underline underline-offset-4"
                    >
                      {item.owner}
                    </Link>
                  ) : (
                    <span className="text-sm">{t("availabilityUnknown")}</span>
                  )}
                </div>
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold">{t("offers")}</h3>
                  {detail.isPending ? (
                    <LoaderCircle className="size-4 animate-spin" aria-label={t("loading")} />
                  ) : detail.isError ? (
                    <p role="alert" className="text-sm text-destructive">
                      {t("loadError")}
                    </p>
                  ) : item.offers.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {t(
                        detail.data?.sources.opensea.available &&
                          detail.data?.sources.gnars.available
                          ? "notListed"
                          : "availabilityUnknown",
                      )}
                    </p>
                  ) : null}
                  {item.offers.map((listing) => (
                    <div key={listing.id} className="space-y-3 border-b pb-4 last:border-b-0">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="break-all font-mono text-xl font-semibold">
                          {formatEther(BigInt(listing.priceWei))} ETH
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {listing.source === "opensea" ? "OpenSea" : "Gnars"}
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
                        listing.source === "gnars" && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => choose("cancel", listing)}
                            disabled={
                              busy || unresolved || !verifiedDetail || !capabilities.localTrading
                            }
                            className="w-full cursor-pointer"
                          >
                            <X className="size-3.5" />
                            {t("cancel")}
                          </Button>
                        )
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
                              : capabilities.localTrading)
                          }
                          className="w-full cursor-pointer"
                        >
                          <ShoppingBag className="size-3.5" />
                          {t("buy")}
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
                {!writer ? (
                  <ConnectButton />
                ) : isOwner ? (
                  <div className="space-y-2">
                    <Button
                      variant="outline"
                      onClick={() => choose("sell")}
                      disabled={busy || unresolved || !verifiedDetail || !capabilities.localTrading}
                      className="w-full cursor-pointer"
                    >
                      <Tag className="size-4" />
                      {t("sell")}
                    </Button>
                    {!capabilities.localTrading && (
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
                      <Label htmlFor="market-price">{t("price")}</Label>
                      <Input
                        id="market-price"
                        inputMode="decimal"
                        autoComplete="off"
                        value={price}
                        placeholder="0.01"
                        onChange={(event) => setPrice(event.target.value)}
                        disabled={busy || success || unresolved}
                        aria-invalid={submitted && !priceWei}
                      />
                      {submitted && !priceWei && (
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
                    <p className="text-xs text-muted-foreground">{t("royaltyNote")}</p>
                    {quoteReady && quote.data ? (
                      <dl className="space-y-2 text-xs">
                        <div className="flex flex-wrap justify-between gap-2">
                          <dt className="text-muted-foreground">{t("royalties")}</dt>
                          <dd className="break-all font-mono">
                            {formatEther(BigInt(quote.data.royaltyWei))} ETH
                          </dd>
                        </div>
                        <div className="flex flex-wrap justify-between gap-2">
                          <dt className="text-muted-foreground">{t("proceeds")}</dt>
                          <dd className="break-all font-mono font-semibold">
                            {formatEther(BigInt(quote.data.sellerWei))} ETH
                          </dd>
                        </div>
                      </dl>
                    ) : quote.isFetching ? (
                      <LoaderCircle className="size-4 animate-spin" aria-label={t("loading")} />
                    ) : quote.isError ? (
                      <p role="alert" className="text-xs text-destructive">
                        {t("loadError")}
                      </p>
                    ) : null}
                  </div>
                ) : (
                  offer && (
                    <dl className="space-y-3 text-sm">
                      <div>
                        <dt className="text-xs text-muted-foreground">{t("total")}</dt>
                        <dd className="mt-1 break-all font-mono font-semibold">
                          {formatEther(BigInt(offer.priceWei))} ETH
                        </dd>
                      </div>
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
                {phase !== "idle" && (
                  <p role="status" className="flex items-start gap-2 text-sm">
                    {success ? (
                      <Check className="size-4 shrink-0 text-green-600" />
                    ) : busy ? (
                      <LoaderCircle className="size-4 shrink-0 animate-spin" />
                    ) : null}
                    {t(`steps.${phase}`)}
                  </p>
                )}
                {actions.error && (
                  <p role="alert" className="text-sm text-destructive">
                    {t(
                      actions.error.code === "wallet"
                        ? writer
                          ? "errors.rejected"
                          : "errors.wallet"
                        : "errors.generic",
                    )}
                  </p>
                )}
                {unresolved && (
                  <p role="status" className="text-sm text-muted-foreground">
                    {t("transactionPending")}
                  </p>
                )}
                {actions.txHash && (
                  <a
                    className="inline-flex items-center gap-1.5 break-all text-xs underline underline-offset-4"
                    href={`https://basescan.org/tx/${actions.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t("transaction")}
                    <ExternalLink className="size-3" />
                  </a>
                )}
                {!writer ? (
                  <ConnectButton />
                ) : success ? (
                  <Button onClick={() => setOpen(false)} className="w-full">
                    {t("newAction")}
                  </Button>
                ) : (
                  <Button
                    disabled={
                      busy ||
                      unresolved ||
                      (mode === "sell" && !quoteReady) ||
                      !verifiedDetail ||
                      (mode === "sell"
                        ? !capabilities.localTrading
                        : offer?.source === "opensea"
                          ? !capabilities.openseaBuy
                          : !capabilities.localTrading)
                    }
                    onClick={() => void execute()}
                    className="w-full cursor-pointer"
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
                )}
                {actions.txHash && !success && !busy && (
                  <Button
                    variant="outline"
                    onClick={() => void actions.checkStatus()}
                    className="w-full"
                  >
                    <RefreshCw className="size-4" />
                    {t("checkStatus")}
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
