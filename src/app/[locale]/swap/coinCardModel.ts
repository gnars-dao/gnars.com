/**
 * The pure half of the Zora coin card: what to show for a coin the SDK
 * returned, decided without React or a network so it can be unit-tested.
 */
import { ipfsToHttp } from "@/lib/ipfs";

/** The fields of `zora20Token` the card reads. Everything is optional upstream. */
export interface ZoraCoinLike {
  name?: string | null;
  symbol?: string | null;
  description?: string | null;
  address?: string | null;
  marketCap?: string | null;
  marketCapDelta24h?: string | null;
  volume24h?: string | null;
  uniqueHolders?: number | null;
  createdAt?: string | null;
  mediaContent?: {
    mimeType?: string | null;
    originalUri?: string | null;
    previewImage?: {
      small?: string | null;
      medium?: string | null;
      blurhash?: string | null;
    } | null;
  } | null;
  creatorProfile?: {
    handle?: string | null;
    avatar?: { previewImage?: { small?: string | null } | null } | null;
  } | null;
}

export interface CoinMedia {
  kind: "video" | "image";
  src: string;
  /** For a video, the still to show before it plays; for an image, unused. */
  poster?: string;
}

/**
 * The media to put in the middle of the card, or null when the coin has none.
 * Video coins get their original file with the preview as poster; everything
 * else gets the medium preview, falling back to the original.
 */
export function coinMedia(coin: ZoraCoinLike): CoinMedia | null {
  const m = coin.mediaContent;
  if (!m) return null;
  const preview = m.previewImage?.medium ?? m.previewImage?.small ?? null;
  const original = m.originalUri ? ipfsToHttp(m.originalUri) : null;
  const isVideo = (m.mimeType ?? "").startsWith("video/");
  if (isVideo && original)
    return { kind: "video", src: original, poster: preview ? ipfsToHttp(preview) : undefined };
  const still = preview ?? original;
  return still ? { kind: "image", src: ipfsToHttp(still) } : null;
}

/** "$1.2M", "$48.3K", "$912", "—". The SDK reports USD figures as strings. */
export function compactUsd(v: string | number | null | undefined): string {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(n >= 100 ? 0 : 2)}`;
}

/** The 24h move as a signed percent of market cap, or null when either side is unknown. */
export function deltaPercent(coin: ZoraCoinLike): number | null {
  const cap = parseFloat(coin.marketCap ?? "");
  const delta = parseFloat(coin.marketCapDelta24h ?? "");
  if (!Number.isFinite(cap) || !Number.isFinite(delta) || cap <= 0) return null;
  const before = cap - delta;
  if (before <= 0) return null;
  return (delta / before) * 100;
}

/** First sentence-ish of the description, clamped, for the card's one line of copy. */
export function shortDescription(text: string | null | undefined, max = 140): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(" "));
  return `${cut.slice(0, stop > 60 ? stop : max).trim()}…`;
}

/** The Zora page for a coin on Base. */
export const zoraCoinUrl = (address: string) =>
  `https://zora.co/coin/base:${address.toLowerCase()}`;

/**
 * A coin's on-chain metadata (the JSON behind `contractURI()`), in the same
 * shape the SDK gives, so the card draws either without caring which it got.
 * Market figures are absent on this path: the chain knows the media, not the
 * price.
 */
export function onchainToCoin(meta: unknown, address: string): ZoraCoinLike | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  const content = (m.content ?? null) as { mime?: string; uri?: string } | null;
  const image = typeof m.image === "string" ? m.image : null;
  const uri = content?.uri ?? image;
  const name = typeof m.name === "string" ? m.name : null;
  const symbol =
    typeof m.ticker === "string" ? m.ticker : typeof m.symbol === "string" ? m.symbol : null;
  if (!name && !uri) return null;
  return {
    address,
    name,
    symbol,
    description: typeof m.description === "string" ? m.description : null,
    mediaContent: uri
      ? { mimeType: content?.mime ?? null, originalUri: uri, previewImage: null }
      : null,
  };
}
