"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, TrendingDown, TrendingUp, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { type SwapToken } from "./chains";
import { coinMedia, compactUsd, deltaPercent, shortDescription } from "./coinCardModel";
import {
  shouldFetchTokenMetadata,
  tokenCardIdentity,
  verifiedStock,
  type TokenMetadata,
} from "./tokenCardModel";

function useTokenMetadata(token: SwapToken, chainId: number) {
  const address = token.address.toLowerCase();
  return useQuery({
    queryKey: ["swap-token-metadata", chainId, address],
    enabled: shouldFetchTokenMetadata(token, chainId),
    staleTime: 10 * 60 * 1000,
    retry: false,
    queryFn: async ({ signal }): Promise<TokenMetadata | null> => {
      const res = await fetch(`/api/coins/meta?address=${address}`, { signal });
      if (!res.ok) return null;
      const body = (await res.json()) as TokenMetadata;
      return { coin: body.coin ?? null, source: body.source ?? null };
    },
  });
}

export default function SwapTokenCard({
  token,
  counterpart,
  side,
  chainId,
  className,
}: {
  token: SwapToken;
  /** The token on the other side of the swap. */
  counterpart: SwapToken;
  side: "sell" | "buy";
  chainId: number;
  className?: string;
}) {
  const t = useTranslations("swap");
  const { data: metadata } = useTokenMetadata(token, chainId);
  const identity = tokenCardIdentity(token, chainId, metadata ?? undefined);
  const coin = metadata?.coin;
  const stock = verifiedStock(token, chainId);
  const media = coin ? coinMedia(coin) : null;
  const logo = stock?.logo ?? token.logo;
  const source = media?.src ?? logo;
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const delta = coin ? deltaPercent(coin) : null;
  const handle = identity.kind === "zora" ? coin?.creatorProfile?.handle : null;
  const avatar =
    identity.kind === "zora" ? coin?.creatorProfile?.avatar?.previewImage?.small : null;
  const blurb = shortDescription(coin?.description);
  const symbol = stock?.symbol ?? token.symbol;
  const name = stock?.name ?? coin?.name ?? token.name;
  const hasStats =
    coin && [coin.marketCap, coin.volume24h, coin.uniqueHolders].some((value) => value != null);
  const label =
    identity.kind === "zora"
      ? t("coinCard.zoraCoin")
      : identity.kind === "clanker"
        ? t("coinCard.clankerCoin")
        : identity.kind === "stock"
          ? t("coinCard.tokenizedStock")
          : (identity.label ?? t("coinCard.token"));

  return (
    <div
      className={cn(
        "min-w-0 overflow-hidden rounded-lg border border-border bg-card/60 shadow-[0_24px_60px_-30px_rgba(0,0,0,.6)]",
        className,
      )}
      data-testid="swap-token-card"
      data-token-kind={identity.kind}
      data-side={side}
    >
      {/* Creator line */}
      <div className="flex min-h-12 items-center justify-between gap-3 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {avatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatar}
              alt=""
              width={20}
              height={20}
              className="h-5 w-5 shrink-0 rounded-full object-cover"
            />
          ) : (
            <span className="h-5 w-5 shrink-0 rounded-full bg-muted" />
          )}
          <span
            className={cn(
              "text-xs text-muted-foreground",
              handle ? "truncate" : "[overflow-wrap:anywhere]",
            )}
          >
            {handle ? `@${handle}` : label}
          </span>
        </div>
        {identity.href && (
          <a
            href={identity.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {identity.link === "zora"
              ? t("coinCard.viewOnZora")
              : identity.link === "clanker"
                ? t("coinCard.viewOnClanker")
                : t("coinCard.viewOnExplorer")}
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        )}
      </div>

      {/* The media, square, the point of the card */}
      <div className="relative aspect-square w-full bg-muted">
        {source && source !== failedSource && media?.kind === "video" ? (
          <video
            src={media.src}
            poster={media.poster}
            className="h-full w-full object-cover"
            autoPlay
            muted
            loop
            playsInline
            onError={() => setFailedSource(source)}
          />
        ) : source && source !== failedSource ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={source}
            alt={name}
            className={cn("h-full w-full", media ? "object-cover" : "object-contain p-10")}
            loading="lazy"
            onError={() => setFailedSource(source)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center font-mono text-4xl text-muted-foreground/40">
            {symbol.slice(0, 4)}
          </div>
        )}
        <span className="absolute left-3 top-3 rounded-md bg-black/60 px-2 py-0.5 font-mono text-[10px] uppercase text-white backdrop-blur">
          {side === "sell" ? t("coinCard.youSell") : t("coinCard.youBuy")}
        </span>
      </div>

      {/* Name, blurb, market */}
      <div className="flex flex-col gap-2 px-4 pt-3 pb-4">
        <div className="flex items-baseline justify-between gap-3">
          <h3 title={name} className="min-w-0 truncate text-base font-semibold leading-tight">
            {name}
          </h3>
          <span
            title={`$${symbol}`}
            className="max-w-[35%] shrink-0 truncate font-mono text-xs text-muted-foreground"
          >
            ${symbol}
          </span>
        </div>
        {blurb && (
          <p className="text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
            {blurb}
          </p>
        )}
        {hasStats && (
          <dl className="grid grid-cols-3 gap-2 pt-1 font-mono text-[11px]">
            <div>
              <dt className="text-muted-foreground/70">{t("coinCard.marketCap")}</dt>
              <dd className="flex flex-wrap items-center gap-1 text-foreground">
                {compactUsd(coin.marketCap)}
                {delta != null && (
                  <span
                    className={cn(
                      "inline-flex items-center gap-0.5",
                      delta >= 0 ? "text-emerald-500" : "text-red-500",
                    )}
                  >
                    {delta >= 0 ? (
                      <TrendingUp className="h-3 w-3" aria-hidden />
                    ) : (
                      <TrendingDown className="h-3 w-3" aria-hidden />
                    )}
                    {Math.abs(delta).toFixed(1)}%
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground/70">{t("coinCard.volume24h")}</dt>
              <dd className="text-foreground">{compactUsd(coin.volume24h)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground/70">{t("coinCard.holders")}</dt>
              <dd className="flex items-center gap-1 text-foreground">
                <Users className="h-3 w-3 text-muted-foreground/70" aria-hidden />
                {coin.uniqueHolders?.toLocaleString() ?? "—"}
              </dd>
            </div>
          </dl>
        )}
        <p className="pt-1 text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
          {side === "sell"
            ? t("coinCard.tradingFor", { coin: symbol, other: counterpart.symbol })
            : t("coinCard.buyingWith", { coin: symbol, other: counterpart.symbol })}
        </p>
      </div>
    </div>
  );
}
