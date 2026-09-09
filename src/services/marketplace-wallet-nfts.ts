import "server-only";
import { unstable_cache } from "next/cache";
import { getAddress, isAddress, isAddressEqual, zeroAddress, type Address } from "viem";
import { z } from "zod";
import { DAO_ADDRESSES } from "@/lib/config";
import { ipfsToHttp } from "@/lib/ipfs";
import {
  MARKETPLACE_PAGE_SIZE,
  marketplaceUnavailable,
  parseMarketplaceInput,
} from "@/services/marketplace-common";
import type { MarketplaceItem } from "@/types/marketplace";

const addressSchema = z
  .string()
  .refine((value) => isAddress(value, { strict: false }) && value.toLowerCase() !== zeroAddress)
  .transform((value) => getAddress(value));
const cursorSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[\x21-\x7e]+$/);
export const marketplaceWalletQuerySchema = z
  .object({ owner: addressSchema, cursor: cursorSchema.optional() })
  .strict();

export type MarketplaceWalletPage = { items: MarketplaceItem[]; nextCursor: string | null };

const tokenIdSchema = z
  .string()
  .regex(/^(?:[0-9]{1,78}|0x[0-9a-fA-F]{1,64})$/)
  .refine((value) => BigInt(value) < 2n ** 256n)
  .transform((value) => BigInt(value).toString());
const nftSchema = z.object({
  tokenId: tokenIdSchema,
  tokenType: z.string().nullish(),
  name: z.string().nullish(),
  contract: z.object({
    address: addressSchema,
    tokenType: z.string().nullish(),
    name: z.string().nullish(),
    isSpam: z.boolean().nullish(),
    spamClassifications: z.array(z.string()).nullish(),
  }),
  image: z
    .object({
      cachedUrl: z.string().nullish(),
      thumbnailUrl: z.string().nullish(),
      originalUrl: z.string().nullish(),
    })
    .nullish(),
});
const pageSchema = z.object({
  ownedNfts: z.array(nftSchema).max(MARKETPLACE_PAGE_SIZE),
  pageKey: cursorSchema.nullish(),
});

function safeImage(value: string | null | undefined): string | null {
  if (!value || value.length > 8192) return null;
  try {
    const url = new URL(value.startsWith("ipfs://") ? ipfsToHttp(value) : value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (
      /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)/i.test(
        url.hostname,
      )
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

async function readPage(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw marketplaceUnavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2_000_000) {
        await reader.cancel();
        throw marketplaceUnavailable();
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    reader.releaseLock();
  }
}

async function fetchWalletPage(owner: Address, cursor?: string): Promise<MarketplaceWalletPage> {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) throw marketplaceUnavailable("Wallet NFT provider is not configured.");
  try {
    const params = new URLSearchParams({
      owner,
      withMetadata: "true",
      pageSize: String(MARKETPLACE_PAGE_SIZE),
      tokenUriTimeoutInMs: "0",
    });
    if (cursor) params.set("pageKey", cursor);
    const response = await fetch(
      `https://base-mainnet.g.alchemy.com/nft/v3/${encodeURIComponent(key)}/getNFTsForOwner?${params}`,
      { cache: "no-store", signal: AbortSignal.timeout(8000) },
    );
    const page = pageSchema.parse(await readPage(response));
    if (page.pageKey && page.pageKey === cursor) throw marketplaceUnavailable();
    const items = new Map<string, MarketplaceItem>();
    for (const nft of page.ownedNfts) {
      const collection = nft.contract.address;
      // Alchemy's query-level SPAM exclusion is paid-only; use available classification metadata.
      if (
        (nft.tokenType ?? nft.contract.tokenType) !== "ERC721" ||
        (nft.contract.tokenType && nft.contract.tokenType !== "ERC721") ||
        nft.contract.isSpam === true ||
        nft.contract.spamClassifications?.length ||
        isAddressEqual(collection, DAO_ADDRESSES.token)
      )
        continue;
      items.set(`${collection}:${nft.tokenId}`, {
        collectionAddress: collection,
        tokenId: nft.tokenId,
        name: nft.name?.trim().slice(0, 200) || `NFT #${nft.tokenId}`,
        collectionName:
          nft.contract.name?.trim().slice(0, 120) ||
          `${collection.slice(0, 6)}...${collection.slice(-4)}`,
        image:
          safeImage(nft.image?.cachedUrl) ??
          safeImage(nft.image?.thumbnailUrl) ??
          safeImage(nft.image?.originalUrl),
        owner,
        offers: [],
      });
    }
    return { items: [...items.values()], nextCursor: page.pageKey ?? null };
  } catch {
    // Do not return provider URLs, API keys, or untrusted provider error bodies.
    throw marketplaceUnavailable("Wallet NFTs could not be loaded. Try again.");
  }
}

const pendingReads = new Map<string, Promise<MarketplaceWalletPage>>();
const loadWalletPage = unstable_cache(
  (owner: Address, cursor?: string) => {
    const cacheKey = JSON.stringify([owner, cursor]);
    const pending = pendingReads.get(cacheKey);
    if (pending) return pending;
    if (pendingReads.size >= 16)
      throw marketplaceUnavailable("Wallet NFT provider is busy. Try again.");
    const request = fetchWalletPage(owner, cursor).finally(() => pendingReads.delete(cacheKey));
    pendingReads.set(cacheKey, request);
    return request;
  },
  ["marketplace-wallet-nfts-v1"],
  { revalidate: 15 },
);

export async function getMarketplaceWalletNfts(
  rawOwner: string,
  rawCursor?: string,
): Promise<MarketplaceWalletPage> {
  const { owner, cursor } = parseMarketplaceInput(marketplaceWalletQuerySchema, {
    owner: rawOwner,
    cursor: rawCursor,
  });
  // Indexed ownership is discovery only; token details and publication recheck ownerOf on Base.
  return loadWalletPage(owner, cursor);
}
