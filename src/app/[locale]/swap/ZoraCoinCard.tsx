"use client";

import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, TrendingDown, TrendingUp, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { NATIVE_TOKEN, type SwapToken } from "./chains";
import {
  coinMedia,
  compactUsd,
  deltaPercent,
  shortDescription,
  zoraCoinUrl,
  type ZoraCoinLike,
} from "./coinCardModel";

/**
 * The coin behind a token, or null when the token is not a Zora coin.
 *
 * Read through the site's own /api/coins/meta rather than the Zora SDK in
 * the browser: the SDK's endpoint answers a keyless browser call with a
 * Cloudflare block, which is why coins used to show a letter instead of
 * their image. The route calls Zora server-side and falls back to the
 * coin's on-chain metadata when Zora will not answer. One query per
 * address, cached ten minutes.
 */
export function useZoraCoin(address: string, chainId: number, enabled = true) {
  return useQuery({
    queryKey: ["zora-coin-meta", address],
    enabled: enabled && chainId === 8453 && address !== NATIVE_TOKEN,
    staleTime: 10 * 60 * 1000,
    retry: false,
    queryFn: async (): Promise<ZoraCoinLike | null> => {
      const res = await fetch(`/api/coins/meta?address=${address}`);
      if (!res.ok) return null;
      const body = (await res.json()) as { coin?: ZoraCoinLike | null };
      return body.coin ?? null;
    },
  });
}

/**
 * A Zora coin as a card: the media in the middle, the creator above, the
 * market below, and one line saying what you are trading it for.
 *
 * Renders nothing until the SDK confirms the token is a coin, so an ordinary
 * ERC-20 never gets an empty frame. Media is served as it is on Zora — an
 * image, or a muted looping video with its still as poster.
 */
export default function ZoraCoinCard({
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
  const { data: coin } = useZoraCoin(token.address, chainId);
  if (!coin) return null;

  const media = coinMedia(coin);
  const delta = deltaPercent(coin);
  const handle = coin.creatorProfile?.handle ?? null;
  const avatar = coin.creatorProfile?.avatar?.previewImage?.small ?? null;
  const blurb = shortDescription(coin.description);
  const symbol = coin.symbol ?? token.symbol;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-border bg-card/60 shadow-[0_24px_60px_-30px_rgba(0,0,0,.6)]",
        className,
      )}
      data-testid="zora-coin-card"
    >
      {/* Creator line */}
      <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-2">
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
          <span className="truncate text-xs text-muted-foreground">
            {handle ? `@${handle}` : t("coinCard.zoraCoin")}
          </span>
        </div>
        <a
          href={zoraCoinUrl(token.address)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {t("coinCard.viewOnZora")}
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      </div>

      {/* The media, square, the point of the card */}
      <div className="relative aspect-square w-full bg-muted">
        {media?.kind === "video" ? (
          <video
            src={media.src}
            poster={media.poster}
            className="h-full w-full object-cover"
            autoPlay
            muted
            loop
            playsInline
          />
        ) : media ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={media.src}
            alt={coin.name ?? symbol}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center font-mono text-4xl text-muted-foreground/40">
            {symbol.slice(0, 4)}
          </div>
        )}
        <span className="absolute left-3 top-3 rounded-md bg-black/60 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-white backdrop-blur">
          {side === "sell" ? t("coinCard.youSell") : t("coinCard.youBuy")}
        </span>
      </div>

      {/* Name, blurb, market */}
      <div className="space-y-2 px-4 pt-3 pb-4">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="truncate text-base font-semibold leading-tight">{coin.name ?? symbol}</h3>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">${symbol}</span>
        </div>
        {blurb && <p className="text-xs leading-relaxed text-muted-foreground">{blurb}</p>}
        <dl className="grid grid-cols-3 gap-2 pt-1 font-mono text-[11px]">
          <div>
            <dt className="text-muted-foreground/70">{t("coinCard.marketCap")}</dt>
            <dd className="flex items-center gap-1 text-foreground">
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
        <p className="pt-1 text-[11px] text-muted-foreground">
          {side === "sell"
            ? t("coinCard.tradingFor", { coin: symbol, other: counterpart.symbol })
            : t("coinCard.buyingWith", { coin: symbol, other: counterpart.symbol })}
        </p>
      </div>
    </div>
  );
}
