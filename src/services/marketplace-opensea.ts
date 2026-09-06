import "server-only";
import { unstable_cache } from "next/cache";
import { getAddress, zeroAddress, type Address } from "viem";
import { z } from "zod";
import { DAO_ADDRESSES } from "@/lib/config";
import { SEAPORT_ADDRESS } from "@/lib/marketplace/seaport";
import { RequestSecurityError } from "@/lib/server/request-security";
import {
  MARKETPLACE_CACHE_TAG,
  MARKETPLACE_PAGE_SIZE,
  marketplaceAddressSchema,
  marketplaceHashSchema,
  marketplaceUintSchema,
  marketplaceUnavailable,
} from "@/services/marketplace-common";
import { enforceOpenSeaProviderBudget } from "@/services/marketplace-orders";
import type { MarketplaceOffer } from "@/types/marketplace";

const itemSchema = z.object({
  itemType: z.number().int(),
  token: marketplaceAddressSchema,
  identifierOrCriteria: marketplaceUintSchema,
  startAmount: marketplaceUintSchema,
  endAmount: marketplaceUintSchema,
});
const orderSchema = z.object({
  type: z.string(),
  remaining_quantity: z.number().int(),
  price: z.object({
    current: z.object({
      currency: z.string(),
      decimals: z.number().int(),
      value: marketplaceUintSchema,
    }),
  }),
  order_hash: marketplaceHashSchema,
  chain: z.literal("base"),
  status: z.literal("ACTIVE"),
  protocol_address: marketplaceAddressSchema,
  protocol_data: z
    .object({
      parameters: z
        .object({
          offerer: marketplaceAddressSchema,
          offer: z.array(itemSchema).min(1).max(10),
          consideration: z
            .array(itemSchema.extend({ recipient: marketplaceAddressSchema }))
            .min(1)
            .max(10),
          orderType: z.number().int(),
          startTime: marketplaceUintSchema,
          endTime: marketplaceUintSchema,
        })
        .passthrough(),
    })
    .passthrough(),
});

export function marketplaceOpenSeaConfigured() {
  return Boolean(process.env.OPENSEA_API_KEY);
}

/** Node 24 exposes the original number lexeme before JSON rounding can lose wei/salt. */
export function parseOpenSeaJson(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) => {
    if (typeof value !== "number") return value;
    if (!Number.isFinite(value)) throw new Error("Invalid OpenSea numeric value");
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      const source = context?.source;
      if (!source || !/^(0|[1-9][0-9]{0,77})$/.test(source)) {
        throw new Error("OpenSea integer precision is unavailable");
      }
      return source;
    }
    return value;
  });
}

const pendingReads = new Map<string, Promise<unknown>>();
const providerBuckets = {
  read: { window: -1, count: 0, retryAt: 0 },
  fulfillment: { window: -1, count: 0, retryAt: 0 },
};

function reserveLocalRequest(operation: keyof typeof providerBuckets) {
  const now = Date.now();
  const bucket = providerBuckets[operation];
  if (bucket.retryAt > now)
    throw new RequestSecurityError(
      503,
      "OpenSea is temporarily unavailable.",
      Math.ceil((bucket.retryAt - now) / 1000),
    );
  const window = Math.floor(now / 30_000);
  if (bucket.window !== window) {
    bucket.window = window;
    bucket.count = 0;
  }
  if (bucket.count >= (operation === "read" ? 30 : 15))
    throw new RequestSecurityError(
      429,
      "OpenSea request limit reached.",
      30 - (Math.floor(now / 1000) % 30),
    );
  bucket.count += 1;
}

/** Server-owned paths only. Never forward arbitrary URLs, keys, or provider bodies to clients. */
async function fetchOpenSea(path: string, body?: unknown, allowNotFound = false): Promise<unknown> {
  const key = process.env.OPENSEA_API_KEY;
  if (!key) throw marketplaceUnavailable("OpenSea is not configured.");
  const operation = body ? "fulfillment" : "read";
  reserveLocalRequest(operation);
  await enforceOpenSeaProviderBudget(operation);
  let response: Response;
  try {
    response = await fetch(`https://api.opensea.io/api/v2/${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        "x-api-key": key,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw marketplaceUnavailable();
  }
  if (allowNotFound && response.status === 404) return null;
  if (response.status === 429) {
    const header = response.headers.get("retry-after");
    const seconds =
      header && /^\d+$/.test(header)
        ? Number(header)
        : header
          ? (Date.parse(header) - Date.now()) / 1000
          : 60;
    const retryAfter = Math.max(
      1,
      Math.min(3600, Number.isFinite(seconds) ? Math.ceil(seconds) : 60),
    );
    providerBuckets[operation].retryAt = Date.now() + retryAfter * 1000;
    throw new RequestSecurityError(503, "OpenSea is temporarily unavailable.", retryAfter);
  }
  if (!response.ok) throw marketplaceUnavailable();
  try {
    return parseOpenSeaJson(await response.text());
  } catch {
    throw marketplaceUnavailable();
  }
}

function openSeaRequest(path: string, body?: unknown, allowNotFound = false): Promise<unknown> {
  // Share concurrent cache misses only. Purchase revalidation is never served a saved result.
  if (body) return fetchOpenSea(path, body, allowNotFound);
  const pending = pendingReads.get(path);
  if (pending) return pending;
  if (pendingReads.size >= 16)
    return Promise.reject(new RequestSecurityError(503, "OpenSea is temporarily unavailable.", 1));
  const request = fetchOpenSea(path, body, allowNotFound).finally(() => pendingReads.delete(path));
  pendingReads.set(path, request);
  return request;
}

export function normalizeOpenSeaListing(
  raw: unknown,
): { tokenId: string; offer: MarketplaceOffer } | null {
  const state = z
    .object({
      status: z.enum(["ACTIVE", "INACTIVE", "FULFILLED", "EXPIRED", "CANCELLED"]),
      chain: z.string(),
    })
    .safeParse(raw);
  if (!state.success) throw marketplaceUnavailable("OpenSea returned an invalid listing.");
  if (state.data.status !== "ACTIVE" || state.data.chain !== "base") return null;
  const parsed = orderSchema.safeParse(raw);
  if (!parsed.success) throw marketplaceUnavailable("OpenSea returned an invalid listing.");
  const order = parsed.data;
  if (order.type !== "basic" || order.remaining_quantity !== 1) return null;
  if (order.price.current.currency !== "ETH" || order.price.current.decimals !== 18) return null;
  const parameters = order.protocol_data.parameters;
  if (order.protocol_address.toLowerCase() !== SEAPORT_ADDRESS.toLowerCase()) return null;
  if (![0, 1, 2, 3].includes(parameters.orderType) || parameters.offer.length !== 1) return null;
  const nft = parameters.offer[0];
  if (
    nft.itemType !== 2 ||
    nft.token.toLowerCase() !== DAO_ADDRESSES.token.toLowerCase() ||
    nft.startAmount !== "1" ||
    nft.endAmount !== "1"
  )
    return null;
  const now = Math.floor(Date.now() / 1000);
  if (BigInt(parameters.startTime) > BigInt(now) || BigInt(parameters.endTime) <= BigInt(now))
    return null;
  if (BigInt(parameters.endTime) > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  let price = 0n;
  for (const item of parameters.consideration) {
    if (
      item.itemType !== 0 ||
      item.token.toLowerCase() !== zeroAddress ||
      item.identifierOrCriteria !== "0" ||
      item.startAmount !== item.endAmount
    )
      return null;
    price += BigInt(item.startAmount);
  }
  if (price <= 0n || price >= 2n ** 256n) return null;
  if (price !== BigInt(order.price.current.value))
    throw marketplaceUnavailable("OpenSea listing price is inconsistent.");
  return {
    tokenId: nft.identifierOrCriteria,
    offer: {
      id: `opensea:${order.order_hash.toLowerCase()}`,
      source: "opensea",
      orderHash: order.order_hash.toLowerCase() as `0x${string}`,
      protocolAddress: getAddress(order.protocol_address),
      seller: getAddress(parameters.offerer),
      priceWei: price.toString(),
      currency: "ETH",
      expiresAt: Number(parameters.endTime),
    },
  };
}

export const listOpenSeaMarketplace = unstable_cache(
  async (cursor?: string) => {
    const parameters = new URLSearchParams({ limit: String(MARKETPLACE_PAGE_SIZE) });
    if (cursor) parameters.set("next", cursor);
    const raw = await openSeaRequest(`listings/collection/gnars-dao/all?${parameters}`);
    const response = z
      .object({
        listings: z.array(z.unknown()).max(MARKETPLACE_PAGE_SIZE),
        next: z.string().max(1024).nullish(),
      })
      .safeParse(raw);
    if (!response.success) throw marketplaceUnavailable("OpenSea returned an invalid page.");
    const offers = response.data.listings
      .map(normalizeOpenSeaListing)
      .filter((row) => row !== null);
    return { offers, nextCursor: response.data.next || null };
  },
  ["marketplace-opensea-v1"],
  { revalidate: 30, tags: [MARKETPLACE_CACHE_TAG] },
);

export async function getOpenSeaMarketplaceOrder(orderHash: string) {
  const raw = await openSeaRequest(`orders/chain/base/protocol/${SEAPORT_ADDRESS}/${orderHash}`);
  const envelope = z.object({ order: z.object({}).passthrough() }).safeParse(raw);
  if (!envelope.success)
    throw marketplaceUnavailable("OpenSea returned an invalid order response.");
  const order = normalizeOpenSeaListing(envelope.data.order);
  if (!order || order.offer.orderHash.toLowerCase() !== orderHash.toLowerCase()) {
    throw marketplaceUnavailable("This OpenSea listing cannot be purchased here.");
  }
  return order;
}

export const getOpenSeaTokenListing = unstable_cache(
  async (tokenId: string) => {
    const raw = await openSeaRequest(
      `listings/collection/gnars-dao/nfts/${tokenId}/best`,
      undefined,
      true,
    );
    if (raw === null) return null;
    const listing = normalizeOpenSeaListing(raw);
    if (!listing) throw marketplaceUnavailable("This NFT's listing format is not supported.");
    if (listing.tokenId !== tokenId) throw marketplaceUnavailable("OpenSea returned another NFT.");
    return listing;
  },
  ["marketplace-opensea-token-v1"],
  { revalidate: 30, tags: [MARKETPLACE_CACHE_TAG] },
);

export async function requestOpenSeaFulfillment(
  orderHash: string,
  tokenId: string,
  buyer: Address,
) {
  return openSeaRequest("listings/fulfillment_data", {
    listing: { hash: orderHash, chain: "base", protocol_address: SEAPORT_ADDRESS },
    fulfiller: { address: buyer },
    recipient: buyer,
    units_to_fill: 1,
    consideration: { asset_contract_address: DAO_ADDRESSES.token, token_id: tokenId },
    include_optional_creator_fees: false,
  });
}
