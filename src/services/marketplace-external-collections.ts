import "server-only";
import { z } from "zod";
import {
  externalCollectionItemUrl,
  type ExternalCollectionKey,
} from "@/lib/marketplace/external-collections";
import { marketplaceUintSchema } from "@/services/marketplace-common";
import {
  marketplaceOpenSeaConfigured,
  requestOpenSeaCollectionBestListings,
  requestOpenSeaExternalNft,
} from "@/services/marketplace-opensea";
import type { ExternalCollectionItem, ExternalCollectionPage } from "@/types/marketplace";

export const EXTERNAL_COLLECTION_CACHE_TAG = "marketplace-external-collections";
export const EXTERNAL_COLLECTION_PAGE_SIZE = 12;
/** The shared provider read budget is 30 calls per 30s, and each item costs one metadata call. */
const METADATA_CONCURRENCY = 4;

const listingsSchema = z.object({
  listings: z
    .array(
      z.object({
        price: z.object({
          current: z.object({ currency: z.string(), value: marketplaceUintSchema }),
        }),
        asset: z.object({ identifier: marketplaceUintSchema }),
      }),
    )
    .max(50),
});

const nftSchema = z.object({
  nft: z.object({
    name: z.string().max(200).nullish(),
    display_image_url: z.string().max(2048).nullish(),
    image_url: z.string().max(2048).nullish(),
  }),
});

/** Only https artwork is forwarded; provider URLs are never trusted as-is. */
function safeImage(...candidates: (string | null | undefined)[]) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" && !url.username && !url.password) return url.toString();
    } catch {
      continue;
    }
  }
  return null;
}

async function mapWithLimit<T, R>(values: T[], limit: number, map: (value: T) => Promise<R>) {
  const results: R[] = [];
  for (let index = 0; index < values.length; index += limit)
    results.push(...(await Promise.all(values.slice(index, index + limit).map(map))));
  return results;
}

export async function listExternalCollection(
  key: ExternalCollectionKey,
): Promise<ExternalCollectionPage> {
  if (!marketplaceOpenSeaConfigured()) return { items: [], available: false };
  const raw = await requestOpenSeaCollectionBestListings(key, EXTERNAL_COLLECTION_PAGE_SIZE * 2);
  const parsed = listingsSchema.safeParse(raw);
  if (!parsed.success) return { items: [], available: false };

  // OpenSea returns one entry per order, so the same token can repeat at different prices.
  const cheapest = new Map<string, string>();
  for (const listing of parsed.data.listings) {
    if (listing.price.current.currency !== "ETH") continue;
    const tokenId = listing.asset.identifier;
    const priceWei = listing.price.current.value;
    const current = cheapest.get(tokenId);
    if (current === undefined || BigInt(priceWei) < BigInt(current))
      cheapest.set(tokenId, priceWei);
  }
  const tokens = [...cheapest.entries()]
    .sort(([, left], [, right]) => (BigInt(left) < BigInt(right) ? -1 : 1))
    .slice(0, EXTERNAL_COLLECTION_PAGE_SIZE);

  const items = await mapWithLimit(
    tokens,
    METADATA_CONCURRENCY,
    async ([tokenId, priceWei]): Promise<ExternalCollectionItem> => {
      const metadata = nftSchema.safeParse(
        await requestOpenSeaExternalNft(key, tokenId).catch(() => null),
      );
      return {
        tokenId,
        name: metadata.success && metadata.data.nft.name ? metadata.data.nft.name : `#${tokenId}`,
        image: metadata.success
          ? safeImage(metadata.data.nft.display_image_url, metadata.data.nft.image_url)
          : null,
        priceWei,
        url: externalCollectionItemUrl(key, tokenId),
      };
    },
  );
  return { items, available: true };
}
