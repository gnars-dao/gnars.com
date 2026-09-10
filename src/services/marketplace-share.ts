import "server-only";
import { unstable_cache } from "next/cache";
import sharp from "sharp";
import { DAO_ADDRESSES } from "@/lib/config";
import { ipfsToHttp } from "@/lib/ipfs";
import { formatMarketplacePrice } from "@/lib/marketplace-display";
import { parseMarketplaceShareQuery } from "@/lib/marketplace/share";
import { loadMarketplaceToken } from "@/services/marketplace";
import {
  MARKETPLACE_CACHE_TAG,
  MARKETPLACE_OPENSEA_ORDERS_CACHE_TAG,
  MARKETPLACE_ORDERS_CACHE_TAG,
} from "@/services/marketplace-common";
import { getCommunityToken } from "@/services/marketplace-community";

type Target = NonNullable<ReturnType<typeof parseMarketplaceShareQuery>>;
export type MarketplaceShareData = {
  name: string;
  image: string | null;
  price: string | null;
  source: string | null;
};

const loadShareData = unstable_cache(
  async (target: Target): Promise<MarketplaceShareData> => {
    const community =
      target.collectionAddress &&
      target.collectionAddress.toLowerCase() !== DAO_ADDRESSES.token.toLowerCase();
    const page = community
      ? await getCommunityToken(target.collectionAddress!, target.tokenId)
      : await loadMarketplaceToken(target.tokenId);
    const item = page.items.find(
      (candidate) =>
        candidate.tokenId === target.tokenId &&
        (!community ||
          candidate.collectionAddress?.toLowerCase() === target.collectionAddress?.toLowerCase()),
    );
    if (!item) throw new Error("Shared NFT unavailable");
    const offers = item.offers.filter(
      (offer) =>
        page.ownershipVerified === true &&
        offer.expiresAt > Date.now() / 1000 &&
        offer.currency === "ETH" &&
        offer.seller.toLowerCase() === item.owner?.toLowerCase() &&
        (!target.source || offer.source === target.source) &&
        (!target.orderHash || offer.orderHash.toLowerCase() === target.orderHash.toLowerCase()) &&
        /^\d{1,78}$/.test(offer.priceWei),
    );
    const offer = offers.reduce<(typeof offers)[number] | undefined>(
      (lowest, current) =>
        !lowest || BigInt(current.priceWei) < BigInt(lowest.priceWei) ? current : lowest,
      undefined,
    );
    return {
      name:
        Array.from(item.name.replace(/[\x00-\x1f\x7f]/g, " ").trim())
          .slice(0, 72)
          .join("") || `NFT #${target.tokenId}`,
      image: item.image,
      price: offer ? `${formatMarketplacePrice(offer.priceWei).display} ETH` : null,
      source: offer?.source ?? null,
    };
  },
  ["marketplace-share-v1"],
  {
    revalidate: 60,
    tags: [
      "marketplace-community",
      MARKETPLACE_CACHE_TAG,
      MARKETPLACE_ORDERS_CACHE_TAG,
      MARKETPLACE_OPENSEA_ORDERS_CACHE_TAG,
    ],
  },
);

export async function getMarketplaceShareData(
  target: Target,
): Promise<MarketplaceShareData | null> {
  try {
    return await loadShareData(target);
  } catch {
    return null;
  }
}

const imageHosts = new Set([
  "nouns.build",
  "nft-cdn.alchemy.com",
  "i.seadn.io",
  "arweave.net",
  "magic.decentralized-content.com",
  "gateway.pinata.cloud",
  "ipfs.skatehive.app",
  "ipfs.io",
]);
const MAX_IMAGE_BYTES = 4_000_000;

/** NFT metadata is untrusted: image rendering must not become an arbitrary server fetch. */
export async function loadMarketplaceShareArtwork(raw: string | null): Promise<string | null> {
  if (!raw) return null;
  try {
    const url = new URL(ipfsToHttp(raw));
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !imageHosts.has(url.hostname)
    )
      return null;
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
    const mime = response.headers.get("content-type")?.split(";")[0].trim();
    if (
      !response.ok ||
      !response.body ||
      !mime ||
      !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime)
    )
      return null;
    if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > MAX_IMAGE_BYTES) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    if (!length) return null;
    // Satori cannot decode WebP. Normalize bounded raster input, including animated first frames.
    const png = await sharp(Buffer.concat(chunks), {
      limitInputPixels: 16_000_000,
      animated: false,
    })
      .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return null;
  }
}
