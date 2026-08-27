"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getCoin, setApiKey } from "@zoralabs/coins-sdk";
import { ipfsToHttp } from "@/lib/ipfs";
import type { CoinNode, TVItem } from "./types";
import { FALLBACK_ITEMS, mapCoinToTVItem, PRELOAD_THRESHOLD } from "./utils";

/**
 * Convert IPFS URIs to HTTP gateway URLs
 */
function toHttpUrl(url?: string | null): string | undefined {
  if (!url) return undefined;
  return ipfsToHttp(url);
}

/**
 * Normalize all IPFS URLs in a TVItem to HTTP
 */
function normalizeItemUrls(item: TVItem): TVItem {
  return {
    ...item,
    videoUrl: toHttpUrl(item.videoUrl),
    imageUrl: toHttpUrl(item.imageUrl),
    creatorAvatar: toHttpUrl(item.creatorAvatar),
  };
}

// Module-level cache to deduplicate concurrent fetches to /api/tv/feed
let feedCache: { promise: Promise<APIFeedResponse>; timestamp: number } | null = null;
const FEED_CACHE_TTL = 60_000; // 1 minute client-side dedup

async function fetchFeedCached(): Promise<APIFeedResponse> {
  const now = Date.now();
  if (feedCache && now - feedCache.timestamp < FEED_CACHE_TTL) {
    return feedCache.promise;
  }
  // Clear stale/failed cache before creating new promise
  feedCache = null;
  const promise = fetch("/api/tv/feed").then((res) => {
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json() as Promise<APIFeedResponse>;
  });
  // Only cache on success — failed promises are not shared
  const cachedPromise = promise.then(
    (data) => {
      feedCache = { promise: cachedPromise, timestamp: now };
      return data;
    },
    (err) => {
      feedCache = null;
      throw err;
    },
  );
  feedCache = { promise: cachedPromise, timestamp: now };
  return cachedPromise;
}

interface UseTVFeedOptions {
  priorityCoinAddress?: string;
}

// Creator profile for stickers
export interface CreatorCoinImage {
  coinAddress: string;
  imageUrl: string;
  symbol?: string;
}

interface APIFeedResponse {
  items: TVItem[];
  creators: Array<{
    handle: string;
    avatarUrl: string | null;
    coinBalance: number;
    nftBalance: number;
  }>;
  stats: {
    total: number;
    withVideo: number;
    withImage: number;
    gnarsPaired: number;
    droposals: number;
    creatorsCount: number;
    /** Three-state health of each upstream. Not "ok" ⇒ `total` is a floor. */
    creatorContent?: SourceReport;
    farcaster?: SourceReport;
  };
  fetchedAt: string;
  durationMs: number;
}

/** Shape-agnostic view of a source report: all we need on screen is the
 *  verdict, the reason, and any count the payload chose to carry. */
export type SourceReport = { status: "ok" | "incomplete" | "unavailable" } & Record<
  string,
  unknown
>;

interface UseTVFeedReturn {
  items: TVItem[];
  /** Upstream health from the last successful fetch, for /debug/tv. */
  sourceHealth: { creatorContent?: SourceReport; farcaster?: SourceReport } | null;
  creatorCoinImages: CreatorCoinImage[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMoreContent: boolean;
  loadMore: () => void;
}

/**
 * Hook to fetch and manage TV feed content
 *
 * Data is fetched from /api/tv/feed which caches results for 1 hour.
 * Sources:
 * 1. GNARS-paired coins from subgraph (highest priority)
 * 2. Videos from qualified creators (300k+ coins AND 1+ NFT)
 * 3. Content from Gnars profile
 * 4. Droposals (NFT drops from DAO proposals)
 */
export function useTVFeed({ priorityCoinAddress }: UseTVFeedOptions): UseTVFeedReturn {
  const [rawItems, setRawItems] = useState<TVItem[]>([]);
  const [sourceHealth, setSourceHealth] = useState<{
    creatorContent?: SourceReport;
    farcaster?: SourceReport;
  } | null>(null);
  const [creatorCoinImages, setCreatorCoinImages] = useState<CreatorCoinImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMoreContent, setHasMoreContent] = useState(false);

  const loadedCoinAddressesRef = useRef<Set<string>>(new Set());
  const normalizedPriority = priorityCoinAddress?.toLowerCase();

  useEffect(() => {
    const cancelled = { current: false };

    const loadData = async () => {
      try {
        setLoading(true);
        loadedCoinAddressesRef.current = new Set();
        setError(null);

        if (process.env.NEXT_PUBLIC_ZORA_API_KEY) {
          setApiKey(process.env.NEXT_PUBLIC_ZORA_API_KEY);
        }

        console.log("[gnars-tv] Fetching feed from API...");

        // Fetch priority coin and feed in parallel (not sequentially)
        const priorityCoinPromise = normalizedPriority
          ? getCoin({
              address: normalizedPriority as `0x${string}`,
              chain: 8453,
            }).catch((err: unknown) => {
              console.error("[gnars-tv] Failed to fetch priority coin", {
                coinAddress: normalizedPriority,
                error: err,
              });
              return null;
            })
          : null;

        const feedPromise = fetchFeedCached();

        const [priorityCoinResponse, data] = await Promise.all([priorityCoinPromise, feedPromise]);

        let priorityItem: TVItem | null = null;
        if (priorityCoinResponse) {
          const coin = priorityCoinResponse?.data?.zora20Token as CoinNode | undefined;
          if (coin) {
            priorityItem = mapCoinToTVItem(
              coin,
              0,
              coin?.creatorProfile?.handle || normalizedPriority!,
            );
            if (priorityItem?.coinAddress) {
              loadedCoinAddressesRef.current.add(priorityItem.coinAddress.toLowerCase());
            }
          }
        }

        if (cancelled.current) return;

        console.log(`[gnars-tv] API returned ${data.items.length} items in ${data.durationMs}ms`);
        console.log(
          `[gnars-tv] Stats: ${data.stats.withVideo} videos, ${data.stats.gnarsPaired} GNARS-paired, ${data.stats.creatorsCount} creators`,
        );

        setSourceHealth({
          creatorContent: data.stats.creatorContent,
          farcaster: data.stats.farcaster,
        });
        // A degraded source is worth a line in the console too: /debug/tv is
        // where it is readable, but nobody opens /debug/tv unprompted.
        for (const [name, report] of Object.entries({
          creatorContent: data.stats.creatorContent,
          farcaster: data.stats.farcaster,
        })) {
          if (report && report.status !== "ok") {
            console.warn(`[gnars-tv] source "${name}" is ${report.status}:`, report);
          }
        }

        // Build sticker images from creator avatars (normalize IPFS URLs)
        const coinImages: CreatorCoinImage[] = data.creators
          .filter((c) => c.avatarUrl)
          .map((c) => ({
            coinAddress: c.handle,
            imageUrl: toHttpUrl(c.avatarUrl) || c.avatarUrl!,
            symbol: c.handle,
          }));

        setCreatorCoinImages(coinImages);

        // Filter out priority coin if already in list and normalize URLs
        let items = data.items.map(normalizeItemUrls);
        if (priorityItem?.coinAddress) {
          items = items.filter(
            (item) => item.coinAddress?.toLowerCase() !== priorityItem!.coinAddress?.toLowerCase(),
          );
        }

        // Add priority item at the top (also normalized)
        const normalizedPriorityItem = priorityItem ? normalizeItemUrls(priorityItem) : null;
        const finalItems = normalizedPriorityItem ? [normalizedPriorityItem, ...items] : items;

        // Track loaded addresses
        for (const item of finalItems) {
          if (item.coinAddress) {
            loadedCoinAddressesRef.current.add(item.coinAddress.toLowerCase());
          }
        }

        setRawItems(finalItems.length ? finalItems : FALLBACK_ITEMS);
        setHasMoreContent(false);
      } catch (err) {
        if (cancelled.current) return;
        console.error("[gnars-tv] Feed fetch error:", err);
        setError("Unable to load videos right now");
        setRawItems(FALLBACK_ITEMS);
      } finally {
        if (!cancelled.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    };

    loadData();

    return () => {
      cancelled.current = true;
    };
  }, [normalizedPriority]);

  const loadMore = useCallback(() => {
    // No pagination implemented yet
  }, []);

  return {
    items: rawItems,
    sourceHealth,
    creatorCoinImages,
    loading,
    loadingMore,
    error,
    hasMoreContent,
    loadMore,
  };
}

/**
 * Hook to handle preloading when approaching end of feed
 */
export function usePreloadTrigger(
  activeIndex: number,
  totalItems: number,
  hasMoreContent: boolean,
  loadingMore: boolean,
  loading: boolean,
  loadMore: () => void,
) {
  useEffect(() => {
    if (!totalItems || loading) return;

    const remainingVideos = totalItems - activeIndex - 1;
    if (remainingVideos <= PRELOAD_THRESHOLD && hasMoreContent && !loadingMore) {
      loadMore();
    }
  }, [activeIndex, totalItems, hasMoreContent, loadingMore, loading, loadMore]);
}
