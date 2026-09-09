"use client";

/*
 * Reflective surface adapted from React Bits ReflectiveCard:
 * https://github.com/DavidHDev/react-bits
 * MIT + Commons Clause License Condition v1.0
 * Copyright (c) 2026 David Haz
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, and distribute the Software as part of an
 * application, website, or product, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * Commons Clause Restriction: You may use this Software, including for any
 * commercial purpose, so long as you do not sell, sublicense, or redistribute the
 * components themselves-whether alone, in a bundle, or as a ported version.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { CSSProperties, MouseEventHandler, PointerEvent } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { ArrowUpRight, Clock3, Layers3, Tag } from "lucide-react";
import type { MarketplaceView } from "@/hooks/use-marketplace";
import { formatMarketplacePrice } from "@/lib/marketplace-display";
import type { MarketplaceItem } from "@/types/marketplace";
import { NftArtwork } from "./NftArtwork";

export function MarketplaceCard({
  item,
  view,
  sourcesComplete,
  exactSearch,
  onClick,
}: {
  item: MarketplaceItem;
  view: MarketplaceView;
  sourcesComplete: boolean;
  exactSearch: boolean;
  onClick: MouseEventHandler<HTMLButtonElement>;
}) {
  const t = useTranslations("marketplace");
  const format = useFormatter();
  const offers = [...item.offers].sort((a, b) =>
    BigInt(a.priceWei) < BigInt(b.priceWei) ? -1 : BigInt(a.priceWei) > BigInt(b.priceWei) ? 1 : 0,
  );
  const best = offers[0];
  const price = best ? formatMarketplacePrice(best.priceWei) : null;
  const sources = [...new Set(offers.map((offer) => offer.source))];
  const owned = view === "owned" || view === "selling";
  const expiry = best ? new Date(best.expiresAt * 1000) : null;
  const status =
    view === "catalogue" && !exactSearch
      ? t("viewListings")
      : sourcesComplete
        ? t("notListed")
        : t("availabilityUnknown");

  function reflect(event: PointerEvent<HTMLButtonElement>) {
    if (
      event.pointerType !== "mouse" ||
      !window.matchMedia("(hover: hover) and (prefers-reduced-motion: no-preference)").matches
    ) {
      resetReflection(event);
      return;
    }
    const card = event.currentTarget;
    const bounds = card.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    const y = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
    card.style.setProperty("--card-rotate-x", `${(0.5 - y) * 5}deg`);
    card.style.setProperty("--card-rotate-y", `${(x - 0.5) * 5}deg`);
    card.style.setProperty("--card-reflection", `${x * 100}%`);
  }

  function resetReflection(event: PointerEvent<HTMLButtonElement>) {
    event.currentTarget.style.removeProperty("--card-rotate-x");
    event.currentTarget.style.removeProperty("--card-rotate-y");
    event.currentTarget.style.removeProperty("--card-reflection");
  }

  return (
    <button
      onClick={onClick}
      onPointerMove={reflect}
      onPointerLeave={resetReflection}
      onPointerCancel={resetReflection}
      aria-label={
        item.collectionAddress
          ? t("community.details", { name: item.name })
          : t("details", { id: item.tokenId })
      }
      style={
        {
          "--card-rotate-x": "0deg",
          "--card-rotate-y": "0deg",
          "--card-reflection": "30%",
        } as CSSProperties
      }
      className="group relative isolate flex min-w-0 cursor-pointer flex-col overflow-hidden rounded-lg border border-zinc-400/60 bg-zinc-100 text-left shadow-[0_1px_3px_#00000014,inset_0_0_0_1px_#ffffff80] transition-[transform,box-shadow] duration-200 hover:shadow-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring motion-safe:[transform:perspective(900px)_rotateX(var(--card-rotate-x,0deg))_rotateY(var(--card-rotate-y,0deg))] motion-reduce:transition-none dark:border-zinc-500/70 dark:bg-zinc-900"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(125deg,#ffffff00_10%,#ffffffaa_24%,#71717a20_39%,#ffffff60_52%,#71717a30_70%,#ffffff99_92%)] dark:bg-[linear-gradient(125deg,#ffffff00_10%,#ffffff24_24%,#00000030_39%,#ffffff18_52%,#00000025_70%,#ffffff28_92%)]"
      />
      <div className="relative m-1.5 mb-0 overflow-hidden rounded-[4px] border border-black/10 dark:border-white/10">
        <NftArtwork item={item} sizes="(max-width: 767px) 50vw, (max-width: 1023px) 33vw, 280px" />
        <span className="absolute top-2 left-2 inline-flex items-center gap-1.5 rounded px-2 py-1 text-[10px] font-semibold text-white shadow-sm bg-black/75">
          <span className="size-1.5 rounded-full bg-blue-400" />
          {t("network")}
        </span>
        {owned && (
          <span className="absolute top-2 right-2 rounded bg-black/75 px-2 py-1 text-[10px] font-semibold text-white shadow-sm">
            {t("yours")}
          </span>
        )}
      </div>

      <div className="flex w-full flex-1 flex-col gap-1.5 p-2 md:gap-2 md:p-3">
        <div className="min-w-0">
          <p
            className={
              item.collectionAddress
                ? "mb-0.5 hidden truncate text-[10px] font-medium uppercase text-muted-foreground sm:block"
                : "sr-only"
            }
            title={item.collectionName}
          >
            {item.collectionName ?? t("collection")}
          </p>
          <h2 className="truncate text-sm font-semibold md:text-base" title={item.name}>
            {item.name}
          </h2>
        </div>

        <div className="flex-1">
          {best ? (
            <>
              <p
                className={
                  offers.length === 1 ? "sr-only" : "mb-0.5 text-[10px] text-muted-foreground"
                }
              >
                {offers.length > 1 ? t("from") : t("cardPrice")}
              </p>
              <p
                className="break-words font-mono text-sm font-semibold tabular-nums [overflow-wrap:anywhere] md:text-lg"
                title={`${price?.exact} ${best.currency}`}
                aria-label={`${price?.exact} ${best.currency}`}
              >
                {price?.display} {best.currency}
              </p>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] font-medium text-muted-foreground">
                {sources.map((source) => (
                  <span key={source} className="inline-flex items-center gap-1">
                    <span
                      className={`size-1.5 rounded-full ${source === "opensea" ? "bg-blue-500" : source === "gnars" ? "bg-amber-500" : "bg-emerald-500"}`}
                    />
                    {t(`sourceNames.${source}`)}
                  </span>
                ))}
                {offers.length > 1 && (
                  <span
                    className="inline-flex items-center gap-1"
                    title={t("listingCount", { count: offers.length })}
                  >
                    <Layers3 className="size-3" aria-hidden="true" />
                    {offers.length}
                  </span>
                )}
              </div>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">{status}</p>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t pt-1.5 text-[10px] text-muted-foreground md:text-xs">
          {expiry ? (
            <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <Clock3 className="size-3 shrink-0" aria-hidden="true" />
              <span>{t("expires")}</span>
              <time
                dateTime={expiry.toISOString()}
                title={format.dateTime(expiry, { dateStyle: "medium", timeStyle: "short" })}
              >
                {format.dateTime(expiry, { month: "short", day: "numeric" })}
              </time>
            </span>
          ) : (
            <span className="flex min-w-0 items-center gap-1.5">
              <Tag className="size-3 shrink-0" aria-hidden="true" />
              {owned ? t("sell") : t("viewListings")}
            </span>
          )}
          <ArrowUpRight
            className="size-4 shrink-0 text-foreground transition-transform motion-safe:group-hover:translate-x-0.5 motion-safe:group-hover:-translate-y-0.5"
            aria-hidden="true"
          />
        </div>
      </div>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-10 opacity-15 mix-blend-soft-light transition-opacity duration-200 group-hover:opacity-30 motion-reduce:transition-none"
        style={{
          background:
            "linear-gradient(115deg, transparent 15%, rgba(255,255,255,.8) 28%, transparent 40%, transparent 60%, rgba(255,255,255,.7) 76%, transparent 90%)",
          backgroundSize: "250% 100%",
          backgroundPosition: "var(--card-reflection,30%) 0",
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-20 rounded-lg border border-white/30 shadow-[inset_0_1px_0_#ffffff80,inset_0_-1px_0_#00000020] dark:border-white/15"
      />
    </button>
  );
}
