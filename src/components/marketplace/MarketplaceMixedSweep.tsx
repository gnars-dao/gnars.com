"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Brush, Check, LoaderCircle, Minus, Plus, RefreshCw, ShoppingBag, X } from "lucide-react";
import { getAddress } from "viem";
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
import { formatMarketplacePrice, parseMarketplacePrice } from "@/lib/marketplace-display";
import {
  bindNativeSweepQuote,
  sweepSelection,
  validateMixedSweepPlan,
  type MixedSweepPlan,
} from "@/lib/marketplace/mixed-sweep";
import {
  applySweepConfirmation,
  parseSweepCart,
  type SweepCart,
} from "@/lib/marketplace/sweep-cart";
import type { MarketplaceItem } from "@/types/marketplace";
import { ownSweepListings, type MarketplaceSweepSelection } from "./marketplace-sweep-model";
import { MarketplaceRecovery } from "./MarketplaceRecovery";
import { MarketplaceSourceLogo } from "./MarketplaceSourceLogo";
import { NftArtwork } from "./NftArtwork";

export function MarketplaceMixedSweep({
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
  const desktop = useMediaQuery("(min-width: 768px)");
  const [open, setOpen] = useState(false);
  const [quantity, setQuantity] = useState(3);
  const [maximum, setMaximum] = useState("");
  const [quote, setQuote] = useState<MixedSweepPlan | null>(null);
  const [cart, setCart] = useState<SweepCart | null>(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<"empty" | "quote" | "storage" | null>(null);
  const [now, setNow] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const activeCart = useRef<SweepCart | null>(null);
  const title = useRef<HTMLHeadingElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const buyer = writer ? getAddress(writer.account.address) : undefined;
  const storageKey = buyer ? `gnars:mixed-sweep:v1:8453:${buyer.toLowerCase()}` : null;
  const maximumWei = maximum.trim() ? parseMarketplacePrice(maximum) : null;
  const invalidMaximum = maximum.trim() !== "" && maximumWei === null;
  const manual = selections.length > 0;
  const count = manual ? selections.length : quantity;
  const plan = cart?.plan ?? quote;
  const completed = (cart?.purchased.length ?? 0) + (cart?.skipped.length ?? 0);
  const done = !!cart && completed === cart.plan.items.length;
  const pending =
    cart?.plan.items.filter(
      (item) => !cart.purchased.includes(item.tokenId) && !cart.skipped.includes(item.tokenId),
    ) ?? [];
  const nativeBatch =
    !!plan && plan.items.every((item) => item.offers[0].source === "gnars-contract");
  const blocked =
    actions.isBusy ||
    starting ||
    !!actions.invalidJournal ||
    actions.canResume ||
    actions.canCancelSavedListing ||
    ["pending", "unknown", "confirming", "signing", "saving"].includes(actions.phase);
  const expired = !!plan && plan.expiresAt <= now;
  const own = ownSweepListings(inventory, buyer);
  const selectionKey = JSON.stringify(
    selections.map(({ item, offer }) => [
      item.tokenId,
      offer.source,
      offer.orderHash,
      offer.priceWei,
    ]),
  );
  const latestReview = useRef<() => Promise<void>>(async () => {});

  function persist(next: SweepCart | null) {
    if (!storageKey) return false;
    try {
      if (next) localStorage.setItem(storageKey, JSON.stringify(next));
      else localStorage.removeItem(storageKey);
      activeCart.current = next;
      setCart(next);
      return true;
    } catch {
      setError("storage");
      return false;
    }
  }

  useEffect(() => {
    if (!storageKey || !buyer) return;
    try {
      const raw = localStorage.getItem(storageKey);
      const saved = raw ? parseSweepCart(raw, buyer) : null;
      activeCart.current = saved;
      setCart(saved);
    } catch {
      setError("storage");
    }
    // Account changes remount this component through the marketplace context key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  useEffect(() => {
    if (!open) return;
    setNow(Math.floor(Date.now() / 1000));
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (actions.phase !== "complete" || !actions.recovery || !activeCart.current) return;
    const previous = activeCart.current;
    const next = applySweepConfirmation(previous, {
      ...actions.recovery,
      result: actions.sweepResult,
    });
    if (
      next !== previous &&
      persist(next) &&
      next.purchased.length + next.skipped.length === next.plan.items.length
    )
      onClear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions.phase, actions.recovery?.journalId, actions.sweepResult]);

  async function review() {
    if (!buyer || !open || !enabled || blocked || invalidMaximum || done) return;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    setError(null);
    setQuote(null);
    try {
      const exact = cart
        ? pending.map(sweepSelection)
        : manual
          ? selections.map(({ item, offer }) => sweepSelection({ ...item, offers: [offer] }))
          : undefined;
      const response = await fetch("/api/marketplace/sweep/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: request.signal,
        body: JSON.stringify({
          buyer,
          quantity: exact?.length ?? count,
          ...(exact ? { selections: exact } : {}),
          ...(!cart && maximumWei ? { maxPriceWei: maximumWei.toString() } : {}),
        }),
      });
      const raw = await response.json();
      if (!response.ok) {
        if (raw.code === "SWEEP_EMPTY") {
          setError("empty");
          return;
        }
        throw new Error("Sweep quote unavailable");
      }
      const next = validateMixedSweepPlan(raw, buyer);
      if (
        next.items.length > (exact?.length ?? count) ||
        (exact && next.items.length !== exact.length)
      )
        throw new Error("Sweep selection changed");
      for (const item of next.items) {
        const selected = sweepSelection(item);
        if (
          (!cart && maximumWei && BigInt(selected.priceWei) > maximumWei) ||
          (exact &&
            !exact.some(
              (old) =>
                old.tokenId === selected.tokenId &&
                old.source === selected.source &&
                old.orderHash.toLowerCase() === selected.orderHash.toLowerCase() &&
                old.priceWei === selected.priceWei,
            ))
        )
          throw new Error("Sweep selection changed");
      }
      if (request.signal.aborted) return;
      if (cart) {
        // Only refresh remaining orders. Settled purchases keep their original prices and identities.
        const refreshed = {
          ...cart,
          plan: {
            ...cart.plan,
            expiresAt: next.expiresAt,
            items: cart.plan.items.map(
              (item) => next.items.find((i) => i.tokenId === item.tokenId) ?? item,
            ),
          },
        };
        persist(refreshed);
      } else setQuote(next);
      setNow(Math.floor(Date.now() / 1000));
    } catch {
      if (!request.signal.aborted) setError("quote");
    } finally {
      if (controller.current === request) setLoading(false);
    }
  }
  useEffect(() => {
    latestReview.current = review;
  });
  useEffect(() => {
    controller.current?.abort();
    setQuote(null);
    if (!open || !buyer || !enabled || cart || invalidMaximum || blocked) return;
    const timer = setTimeout(() => void latestReview.current(), 400);
    return () => {
      clearTimeout(timer);
      controller.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, buyer, enabled, count, maximum, selectionKey, !!cart, invalidMaximum, blocked]);
  useEffect(() => () => controller.current?.abort(), []);

  async function purchase() {
    if (
      !buyer ||
      !plan ||
      blocked ||
      loading ||
      done ||
      plan.expiresAt <= Math.floor(Date.now() / 1000)
    )
      return;
    setStarting(true);
    setError(null);
    const queue = cart ?? { plan, purchased: [], skipped: [] };
    const item = queue.plan.items.find(
      (item) => !queue.purchased.includes(item.tokenId) && !queue.skipped.includes(item.tokenId),
    );
    if (!item) {
      setStarting(false);
      return;
    }
    const next = {
      ...queue,
      awaiting: nativeBatch ? "batch" : item.tokenId,
      previousJournalId: actions.recovery?.journalId,
    };
    if (!persist(next)) {
      setStarting(false);
      return;
    }
    try {
      if (nativeBatch) {
        const response = await fetch("/api/marketplace/sweep/quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            buyer,
            quantity: plan.items.length,
            selections: plan.items.map((item) => {
              const { tokenId, orderHash, priceWei } = sweepSelection(item);
              return { tokenId, orderHash, priceWei };
            }),
          }),
        });
        if (!response.ok) throw new Error("Native sweep changed");
        await actions.sweep(bindNativeSweepQuote(plan, await response.json(), buyer));
      } else await actions.buy({ tokenId: item.tokenId, offer: item.offers[0] });
    } catch {
      setError("quote");
    } finally {
      setStarting(false);
    }
  }

  function clear() {
    if (blocked) return;
    if (persist(null)) {
      setQuote(null);
      setError(null);
      onClear();
    }
  }
  const amount = (value: string) => `${formatMarketplacePrice(value).display} ETH`;
  return (
    <>
      {enabled && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur-md">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Brush className="hidden size-5 text-emerald-500 sm:block" />
              <div>
                <p className="text-sm font-semibold">{t("sweep.title")}</p>
                <p className="text-xs text-muted-foreground">{t("sweep.markets")}</p>
              </div>
              {!cart && (
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
                  <span className="w-6 text-center font-mono text-sm">{count}</span>
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
              )}
            </div>
            <Button ref={trigger} onClick={() => setOpen(true)}>
              <ShoppingBag className="size-4" />
              {t(cart ? "sweep.resumeCart" : manual ? "sweep.review" : "sweep.buyFloor")}
            </Button>
          </div>
        </div>
      )}
      <Drawer
        open={open && enabled}
        direction={desktop ? "right" : "bottom"}
        dismissible={!actions.isBusy && !starting}
        onOpenChange={setOpen}
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
                {t("sweep.markets")} / {t("network")}
              </DrawerDescription>
            </div>
            <DrawerClose asChild>
              <Button
                variant="ghost"
                size="icon"
                disabled={actions.isBusy || starting}
                aria-label={t("close")}
              >
                <X className="size-5" />
              </Button>
            </DrawerClose>
          </DrawerHeader>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5">
            {!cart && (
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
                      const n = Number(event.target.value);
                      if (Number.isInteger(n) && n >= 1 && n <= 10) setQuantity(n);
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sweep-max">{t("sweep.maximum")}</Label>
                  <Input
                    id="sweep-max"
                    inputMode="decimal"
                    value={maximum}
                    placeholder={t("sweep.noLimit")}
                    disabled={blocked}
                    aria-invalid={invalidMaximum}
                    onChange={(e) => setMaximum(e.target.value)}
                  />
                  {invalidMaximum && (
                    <p role="alert" className="text-xs text-destructive">
                      {t("sweep.invalidMaximum")}
                    </p>
                  )}
                </div>
              </div>
            )}
            {!writer ? (
              <div className="flex min-h-48 items-center justify-center">
                <ConnectButton />
              </div>
            ) : (
              <>
                <div className="my-4 flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold">
                    {t(cart ? "sweep.progress" : manual ? "sweep.selected" : "sweep.lowestPrices", {
                      count: plan?.items.length ?? count,
                      completed,
                    })}
                  </h3>
                  {!done && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={loading || blocked || invalidMaximum}
                      onClick={() => void review()}
                    >
                      <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} />
                      {t("sweep.refreshQuote")}
                    </Button>
                  )}
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
                {error && error !== "empty" && (
                  <p role="alert" className="my-4 text-sm text-destructive">
                    {t(error === "storage" ? "sweep.storageError" : "sweep.quoteError")}
                  </p>
                )}
                {error === "empty" && (
                  <>
                    <p role="status" className="py-5 text-sm text-muted-foreground">
                      {t(maximumWei ? "sweep.emptyWithLimit" : "sweep.empty")}
                    </p>
                    <p className="text-xs text-muted-foreground">{t("sweep.combinedScope")}</p>
                    {own.length > 0 && (
                      <section aria-label={t("sweep.ownListings")} className="mt-4">
                        <h3 className="text-sm font-semibold">{t("sweep.ownListings")}</h3>
                        <ul className="divide-y">
                          {own.map(({ item }) => (
                            <li key={item.tokenId} className="flex items-center gap-3 py-3">
                              <div className="w-16 shrink-0">
                                <NftArtwork item={item} sizes="64px" />
                              </div>
                              <div>
                                <p className="text-sm font-semibold">{item.name}</p>
                                <p className="text-xs text-muted-foreground">
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
                {plan && (
                  <>
                    {!cart && plan.items.length < count && (
                      <p className="text-sm text-amber-600 dark:text-amber-400">
                        {t("sweep.fewer", { count: plan.items.length, requested: count })}
                      </p>
                    )}
                    <ul className="divide-y">
                      {plan.items.map((item) => (
                        <li key={item.tokenId} className="flex items-center gap-3 py-3">
                          <div className="w-16 shrink-0 overflow-hidden rounded-md">
                            <NftArtwork item={item} sizes="64px" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold">{item.name}</p>
                            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                              <MarketplaceSourceLogo source={item.offers[0].source} />
                              {t(`sourceNames.${item.offers[0].source}`)}
                            </p>
                            {cart?.purchased.includes(item.tokenId) && (
                              <p className="mt-1 flex items-center gap-1 text-xs text-emerald-600">
                                <Check className="size-3" />
                                {t("sweep.purchased")}
                              </p>
                            )}
                            {cart?.skipped.includes(item.tokenId) && (
                              <p className="mt-1 text-xs text-muted-foreground">
                                {t("sweep.skipped", { count: 1 })}
                              </p>
                            )}
                          </div>
                          <p className="max-w-[40%] break-all text-right font-mono text-sm">
                            {amount(item.offers[0].priceWei)}
                          </p>
                          {manual && !cart && (
                            <Button
                              variant="ghost"
                              size="icon"
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
                    <p className="mt-4 border-y py-4 text-sm text-muted-foreground">
                      {t(nativeBatch ? "sweep.partialWarning" : "sweep.separateWarning", {
                        count: plan.items.length,
                      })}
                    </p>
                  </>
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
                {plan ? amount(plan.totalWei) : "-"}
              </strong>
            </div>
            <p className="text-xs text-muted-foreground">{t("sweep.feesIncluded")}</p>
            {expired && !done && (
              <p role="alert" className="text-sm text-amber-600 dark:text-amber-400">
                {t("sweep.expired")}
              </p>
            )}
            {done ? (
              <Button className="w-full" onClick={clear}>
                {t("close")}
              </Button>
            ) : (
              <Button
                className="w-full"
                disabled={!writer || !plan || expired || loading || blocked || error === "storage"}
                onClick={() => void purchase()}
              >
                {starting || actions.isBusy ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <ShoppingBag className="size-4" />
                )}
                {t(nativeBatch ? "sweep.confirm" : "sweep.confirmStep", {
                  count: plan?.items.length ?? count,
                  step: completed + 1,
                })}
              </Button>
            )}
            {cart && !done && (
              <Button variant="ghost" className="w-full" disabled={blocked} onClick={clear}>
                {t("sweep.stopRemaining")}
              </Button>
            )}
          </footer>
        </DrawerContent>
      </Drawer>
    </>
  );
}
