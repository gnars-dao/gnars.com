"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import {
  Brush,
  CircleAlert,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  ShoppingBag,
  X,
} from "lucide-react";
import { formatEther, getAddress } from "viem";
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
import { useMarketplaceActions } from "@/hooks/use-marketplace-actions";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useWriteAccount } from "@/hooks/use-write-account";
import { getConfiguredGnarsMarketplaceAddress } from "@/lib/config";
import { formatMarketplacePrice, parseMarketplacePrice } from "@/lib/marketplace-display";
import { getListingOrderHash, getListingPriceWei } from "@/lib/marketplace/seaport";
import type { SweepQuote } from "@/lib/marketplace/sweep";
import { validateSweepQuote } from "@/lib/marketplace/sweep-journal";
import type { MarketplaceItem } from "@/types/marketplace";
import type { MarketplaceSweepSelection } from "./marketplace-sweep-model";
import { ownSweepListings } from "./marketplace-sweep-model";
import { MarketplaceRecovery } from "./MarketplaceRecovery";
import { NftArtwork } from "./NftArtwork";

export function MarketplaceSweep({
  selections,
  inventory,
  onClear,
  onRemove,
  enabled,
}: {
  selections: MarketplaceSweepSelection[];
  inventory: MarketplaceItem[];
  onClear: () => void;
  onRemove: (tokenId: string) => void;
  enabled: boolean;
}) {
  const t = useTranslations("marketplace");
  const writer = useWriteAccount();
  const actions = useMarketplaceActions();
  const queryClient = useQueryClient();
  const desktop = useMediaQuery("(min-width: 768px)");
  const [open, setOpen] = useState(false);
  const [quantity, setQuantity] = useState(3);
  const [maximum, setMaximum] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorState, setError] = useState<{ key: string; empty: boolean } | null>(null);
  const [savedQuote, setSavedQuote] = useState<{ key: string; quote: SweepQuote } | null>(null);
  const [now, setNow] = useState(0);
  const request = useRef<AbortController | null>(null);
  const scheduledReview = useRef<ReturnType<typeof setTimeout> | null>(null);
  const title = useRef<HTMLHeadingElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const manual = selections.length > 0;
  const count = manual ? selections.length : quantity;
  const maxWei = maximum.trim() ? parseMarketplacePrice(maximum) : null;
  const invalidMax = maximum.trim() !== "" && maxWei === null;
  const key = JSON.stringify([
    writer?.account.address.toLowerCase(),
    getConfiguredGnarsMarketplaceAddress()?.toLowerCase(),
    count,
    maximum,
    selections.map(({ item, offer }) => [item.tokenId, offer.orderHash, offer.priceWei]),
  ]);
  const quote = savedQuote?.key === key ? savedQuote.quote : null;
  const error = errorState?.key === key ? errorState : null;
  const empty = error?.empty || (!!quote && !quote.items.length);
  const ownListings = ownSweepListings(
    inventory,
    writer ? getAddress(writer.account.address) : undefined,
  );
  const expired = !!quote && quote.expiresAt <= now;
  const blocked =
    actions.isBusy ||
    !!actions.invalidJournal ||
    actions.canResume ||
    actions.canCancelSavedListing ||
    ["pending", "unknown", "confirming", "signing", "saving"].includes(actions.phase);
  const selectedTotal = selections.reduce((total, { offer }) => total + BigInt(offer.priceWei), 0n);
  const requestKey = useRef(key);
  useEffect(() => {
    requestKey.current = key;
  }, [key]);

  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!quote || !open) return;
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, [quote, open]);
  const result = actions.sweepResult;
  const lastResult = useRef(result);
  useEffect(() => {
    if (!result || result === lastResult.current) return;
    lastResult.current = result;
    onClear();
    void queryClient.invalidateQueries({ queryKey: ["marketplace"] });
  }, [result, onClear, queryClient]);

  async function review() {
    if (!open || !enabled || !writer || invalidMax || blocked) return;
    if (scheduledReview.current) clearTimeout(scheduledReview.current);
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const requestedKey = key;
    setLoading(true);
    setError(null);
    setSavedQuote(null);
    try {
      if (actions.phase === "complete") await actions.reset();
      const response = await fetch("/api/marketplace/sweep/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          buyer: writer.account.address,
          quantity: count,
          ...(maxWei ? { maxPriceWei: maxWei.toString() } : {}),
          ...(manual
            ? {
                selections: selections.map(({ item, offer }) => ({
                  tokenId: item.tokenId,
                  orderHash: offer.orderHash,
                  priceWei: offer.priceWei,
                })),
              }
            : {}),
        }),
      });
      if (!response.ok) {
        const body = await response.json();
        if (
          body?.code === "SWEEP_EMPTY" &&
          requestKey.current === requestedKey &&
          !controller.signal.aborted
        ) {
          setError({ key: requestedKey, empty: true });
          return;
        }
        throw new Error("Sweep unavailable");
      }
      let next: SweepQuote = await response.json();
      if (
        !Array.isArray(next.items) ||
        !Array.isArray(next.listings) ||
        next.items.length !== next.listings.length ||
        next.items.length > count ||
        (manual && next.items.length !== selections.length) ||
        !/^\d+$/.test(next.totalWei) ||
        !Number.isSafeInteger(next.expiresAt)
      )
        throw new Error("Invalid sweep quote");
      if (next.listings.length) {
        next = validateSweepQuote(next, getAddress(writer.account.address));
        for (const listing of next.listings) {
          const tokenId = listing.parameters.offer[0].identifierOrCriteria;
          const priceWei = getListingPriceWei(listing);
          if (maxWei && priceWei > maxWei) throw new Error("Invalid sweep item");
          if (
            manual &&
            !selections.some(
              ({ item, offer }) =>
                item.tokenId === tokenId &&
                offer.orderHash.toLowerCase() ===
                  getListingOrderHash(listing.parameters).toLowerCase() &&
                BigInt(offer.priceWei) === priceWei,
            )
          )
            throw new Error("Sweep selection changed");
        }
      } else if (next.totalWei !== "0") throw new Error("Invalid empty sweep");
      if (requestKey.current === requestedKey && !controller.signal.aborted) {
        setNow(Math.floor(Date.now() / 1000));
        setSavedQuote({ key: requestedKey, quote: next });
      }
    } catch {
      if (!controller.signal.aborted && requestKey.current === requestedKey)
        setError({ key: requestedKey, empty: false });
    } finally {
      if (request.current === controller) setLoading(false);
    }
  }

  const latestReview = useRef(review);
  useEffect(() => {
    latestReview.current = review;
  });
  const hasWriter = !!writer;
  const hasResult = !!result;
  useEffect(() => {
    request.current?.abort();
    setLoading(false);
    if (!open || !enabled || !hasWriter || invalidMax || blocked || hasResult) return;
    scheduledReview.current = setTimeout(() => void latestReview.current(), 400);
    return () => {
      if (scheduledReview.current) clearTimeout(scheduledReview.current);
      request.current?.abort();
    };
  }, [key, open, enabled, hasWriter, invalidMax, blocked, hasResult]);

  function showReview() {
    setOpen(true);
  }

  return (
    <>
      {enabled && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] shadow-[0_-4px_24px_#00000012] backdrop-blur-md">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <Brush className="hidden size-5 text-emerald-500 sm:block" />
              <div>
                <p className="text-sm font-semibold">{t("sweep.title")}</p>
                <p className="text-[11px] text-muted-foreground">
                  {t("sourceNames.gnars-contract")}
                </p>
              </div>
              <div className="flex h-10 items-center rounded-md border">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("sweep.less")}
                  disabled={manual || quantity <= 1 || blocked}
                  onClick={() => setQuantity(quantity - 1)}
                >
                  <Minus className="size-3.5" />
                </Button>
                <span className="w-6 text-center font-mono text-sm tabular-nums" aria-live="polite">
                  {count}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("sweep.more")}
                  disabled={manual || quantity >= 10 || blocked}
                  onClick={() => setQuantity(quantity + 1)}
                >
                  <Plus className="size-3.5" />
                </Button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {manual && (
                <>
                  <span
                    className="hidden font-mono text-sm sm:block"
                    title={`${formatEther(selectedTotal)} ETH`}
                  >
                    {formatMarketplacePrice(selectedTotal.toString()).display} ETH
                  </span>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t("sweep.clear")}
                    disabled={blocked}
                    onClick={onClear}
                  >
                    <X className="size-4" />
                  </Button>
                </>
              )}
              <Button
                ref={trigger}
                onClick={showReview}
                className="cursor-pointer"
                disabled={blocked}
              >
                <ShoppingBag className="size-4" />
                {t(manual ? "sweep.review" : "sweep.buyFloor")}
              </Button>
            </div>
          </div>
        </div>
      )}
      <Drawer
        open={open && enabled}
        direction={desktop ? "right" : "bottom"}
        dismissible={!actions.isBusy}
        onOpenChange={(value) => {
          if (!actions.isBusy) setOpen(value);
        }}
        autoFocus
        fixed
      >
        <DrawerContent
          className="overflow-hidden data-[vaul-drawer-direction=bottom]:mt-0 data-[vaul-drawer-direction=bottom]:h-[92dvh] data-[vaul-drawer-direction=bottom]:max-h-[92dvh] data-[vaul-drawer-direction=right]:w-[min(560px,100vw)] data-[vaul-drawer-direction=right]:sm:max-w-[560px] motion-reduce:!transition-none"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            title.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        >
          <DrawerHeader className="flex-row items-center justify-between border-b p-5 text-left group-data-[vaul-drawer-direction=bottom]/drawer-content:text-left">
            <div>
              <DrawerTitle ref={title} tabIndex={-1} className="text-xl outline-none">
                {t("sweep.title")}
              </DrawerTitle>
              <DrawerDescription className="mt-1">
                {t("sourceNames.gnars-contract")} / {t("network")}
              </DrawerDescription>
            </div>
            <DrawerClose asChild>
              <Button variant="ghost" size="icon" disabled={actions.isBusy} aria-label={t("close")}>
                <X className="size-5" />
              </Button>
            </DrawerClose>
          </DrawerHeader>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5">
            <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-4 border-b pb-5">
              <div className="space-y-2">
                <Label htmlFor="sweep-count">{t("sweep.quantity")}</Label>
                <Input
                  id="sweep-count"
                  type="number"
                  min={1}
                  max={10}
                  value={count}
                  disabled={manual || blocked}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isInteger(value) && value >= 1 && value <= 10) setQuantity(value);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sweep-max">{t("sweep.maximum")}</Label>
                <Input
                  id="sweep-max"
                  value={maximum}
                  inputMode="decimal"
                  placeholder={t("sweep.noLimit")}
                  aria-invalid={invalidMax}
                  disabled={blocked}
                  onChange={(event) => setMaximum(event.target.value)}
                />
                {invalidMax && (
                  <p role="alert" className="text-xs text-destructive">
                    {t("sweep.invalidMaximum")}
                  </p>
                )}
              </div>
            </div>
            {!writer ? (
              <div className="flex min-h-48 items-center justify-center">
                <ConnectButton />
              </div>
            ) : (
              <>
                <div className="my-4 flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold">
                    {t(manual ? "sweep.selected" : "sweep.lowestPrices", { count })}
                  </h3>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loading || invalidMax || blocked}
                    onClick={() => void review()}
                  >
                    <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} />
                    {t("sweep.refreshQuote")}
                  </Button>
                </div>
                {loading && (
                  <p
                    role="status"
                    className="flex min-h-36 items-center justify-center gap-2 text-sm text-muted-foreground"
                  >
                    <LoaderCircle className="size-4 animate-spin" />
                    {t("sweep.loading")}
                  </p>
                )}
                {error && !error.empty && (
                  <p role="alert" className="my-4 text-sm text-destructive">
                    {t("sweep.quoteError")}
                  </p>
                )}
                {!loading && empty && (
                  <>
                    <div role="status" className="space-y-2 py-5 text-sm text-muted-foreground">
                      <p>{t(maxWei ? "sweep.emptyWithLimit" : "sweep.empty")}</p>
                      <p>{t("sweep.scope")}</p>
                    </div>
                    {ownListings.length > 0 && (
                      <section aria-label={t("sweep.ownListings")}>
                        <h3 className="text-sm font-semibold">{t("sweep.ownListings")}</h3>
                        <ul className="divide-y">
                          {ownListings.map(({ item }) => (
                            <li key={item.tokenId} className="flex items-center gap-3 py-3">
                              <div className="w-16 shrink-0 overflow-hidden rounded-md">
                                <NftArtwork item={item} sizes="64px" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-semibold">{item.name}</p>
                                <p className="mt-1 text-xs text-muted-foreground">
                                  {t("sweep.ownListingExcluded")}
                                </p>
                              </div>
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}
                  </>
                )}
                {!loading && quote && quote.items.length > 0 && (
                  <>
                    {quote.items.length < count && (
                      <p role="status" className="mb-4 text-sm text-amber-600 dark:text-amber-400">
                        {t("sweep.fewer", { count: quote.items.length, requested: count })}
                      </p>
                    )}
                    <ul className="divide-y">
                      {quote.items.map((item, index) => (
                        <li key={item.tokenId} className="flex items-center gap-3 py-3">
                          <div className="w-16 shrink-0 overflow-hidden rounded-md">
                            <NftArtwork item={item} sizes="64px" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold">{item.name}</p>
                            <p className="mt-1 text-xs text-muted-foreground">#{item.tokenId}</p>
                          </div>
                          <p className="max-w-[45%] break-all text-right font-mono text-sm">
                            {formatEther(getListingPriceWei(quote.listings[index]))} ETH
                          </p>
                          {manual && (
                            <Button
                              size="icon"
                              variant="ghost"
                              disabled={blocked}
                              aria-label={t("sweep.remove", { id: item.tokenId })}
                              onClick={() => onRemove(item.tokenId)}
                            >
                              <X className="size-4" />
                            </Button>
                          )}
                        </li>
                      ))}
                    </ul>
                    <div className="mt-4 flex items-start gap-2 border-y py-4 text-sm text-muted-foreground">
                      <CircleAlert className="mt-0.5 size-4 shrink-0" />
                      <p>{t("sweep.partialWarning")}</p>
                    </div>
                  </>
                )}
                {!loading && !quote && !error && (
                  <p className="py-8 text-sm text-muted-foreground">{t("sweep.reviewAgain")}</p>
                )}
              </>
            )}
            <div className="mt-5">
              <MarketplaceRecovery showCompleted />
            </div>
          </div>
          <footer className="shrink-0 space-y-3 border-t px-5 pt-4 pb-[max(20px,env(safe-area-inset-bottom))]">
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm font-medium">{t("sweep.maximumTotal")}</span>
              <strong className="break-all text-right font-mono text-lg">
                {quote ? `${formatEther(BigInt(quote.totalWei))} ETH` : "-"}
              </strong>
            </div>
            <p className="text-xs text-muted-foreground">{t("sweep.feesIncluded")}</p>
            {expired && (
              <p role="alert" className="text-sm text-amber-600 dark:text-amber-400">
                {t("sweep.expired")}
              </p>
            )}
            <Button
              className="w-full cursor-pointer"
              disabled={
                !writer ||
                !quote?.items.length ||
                expired ||
                loading ||
                blocked ||
                !!actions.sweepResult
              }
              onClick={() => {
                if (quote && quote.expiresAt > Math.floor(Date.now() / 1000))
                  void actions.sweep(quote);
                else setNow(Math.floor(Date.now() / 1000));
              }}
            >
              {actions.isBusy ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <ShoppingBag className="size-4" />
              )}
              {t("sweep.confirm", { count: quote?.items.length ?? count })}
            </Button>
          </footer>
        </DrawerContent>
      </Drawer>
    </>
  );
}
