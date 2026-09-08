import "server-only";
import { revalidateTag, unstable_cache } from "next/cache";
import { getAddress, zeroAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { DAO_ADDRESSES } from "@/lib/config";
import {
  buildOpenSeaListingQuote,
  getOpenSeaCancellation,
  parseOpenSeaListingFees,
  validateOpenSeaListingFees,
} from "@/lib/marketplace/opensea-listing";
import {
  getListingOrderHash,
  getListingPriceWei,
  SEAPORT_ADDRESS,
  seaportAbi,
  validateListingOnchain,
  validateListingStructure,
  type SignedListing,
} from "@/lib/marketplace/seaport";
import { RequestSecurityError } from "@/lib/server/request-security";
import {
  MARKETPLACE_CACHE_TAG,
  MARKETPLACE_OPENSEA_ORDERS_CACHE_TAG,
  MARKETPLACE_PAGE_SIZE,
  marketplaceAddressSchema,
  marketplaceClient,
  marketplaceHashSchema,
  MarketplaceServiceError,
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
const OPENSEA_FEES_CACHE_TAG = "marketplace-opensea-listing-fees";
let lastOrdersInvalidation: number | null = null;
const invalidatedOrders = new Map<string, number>();

/** Per-instance protection against replay-driven global cache misses, not a distributed limit. */
export function invalidateOpenSeaOrdersCache(orderHash: Hex): boolean {
  const now = Date.now();
  const key = orderHash.toLowerCase();
  const previous = invalidatedOrders.get(key);
  if (
    (lastOrdersInvalidation !== null && now - lastOrdersInvalidation < 5_000) ||
    (previous !== undefined && now - previous < 30_000)
  )
    return false;
  revalidateTag(MARKETPLACE_OPENSEA_ORDERS_CACHE_TAG, { expire: 0 });
  lastOrdersInvalidation = now;
  if (invalidatedOrders.size >= 1000) {
    const oldest = invalidatedOrders.keys().next().value;
    if (oldest !== undefined) invalidatedOrders.delete(oldest);
  }
  invalidatedOrders.delete(key);
  invalidatedOrders.set(key, now);
  return true;
}
const providerBuckets = {
  read: { window: -1, count: 0, retryAt: 0 },
  fulfillment: { window: -1, count: 0, retryAt: 0 },
  posting: { window: -1, count: 0, retryAt: 0 },
};

/** Only static diagnostic categories leave the server, never provider-supplied text. */
async function rejectedOpenSeaOrder(response: Response) {
  const body = await response.json().catch(() => null);
  const parsed = z.object({ errors: z.array(z.string().max(4000)).max(20) }).safeParse(body);
  const text = parsed.success ? parsed.data.errors.join(" ").toLowerCase() : "";
  for (const [pattern, code, message] of [
    [/conduit/, "OPENSEA_CONDUIT_INVALID", "OpenSea rejected the order's transfer conduit."],
    [/signature|signer/, "OPENSEA_SIGNATURE_INVALID", "OpenSea rejected the order signature."],
    [/fee|royalt/, "OPENSEA_FEE_INVALID", "OpenSea rejected the order's fee configuration."],
    [/zone/, "OPENSEA_ZONE_INVALID", "OpenSea rejected the order's zone configuration."],
  ] as const) {
    if (pattern.test(text)) return new MarketplaceServiceError(422, message, code, false);
  }
  return new MarketplaceServiceError(
    422,
    "OpenSea rejected this signed order. Review the listing before trying again.",
    "OPENSEA_ORDER_REJECTED",
    false,
  );
}

function reserveLocalRequest(operation: keyof typeof providerBuckets) {
  const now = Date.now();
  const bucket = providerBuckets[operation];
  if (bucket.retryAt > now)
    throw new MarketplaceServiceError(
      503,
      `OpenSea ${operation} is temporarily unavailable (rate-limit cooldown).`,
      "OPENSEA_RATE_LIMITED",
      true,
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
async function fetchOpenSea(
  path: string,
  body?: unknown,
  allowNotFound = false,
  operation: keyof typeof providerBuckets = body ? "fulfillment" : "read",
): Promise<unknown> {
  const key = process.env.OPENSEA_API_KEY;
  if (!key) throw marketplaceUnavailable("OpenSea is not configured.");
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
    throw new MarketplaceServiceError(
      503,
      `OpenSea ${operation} unavailable: network request failed.`,
      "OPENSEA_UNAVAILABLE",
      true,
    );
  }
  if (allowNotFound && response.status === 404) return null;
  // OpenSea's canonical lookup also uses this exact 400 response for absent orders.
  if (
    allowNotFound &&
    !body &&
    response.status === 400 &&
    path.startsWith(`orders/chain/base/protocol/${SEAPORT_ADDRESS}/`)
  ) {
    const missing = z
      .object({ errors: z.tuple([z.literal("Order not found")]) })
      .strict()
      .safeParse(await response.json().catch(() => null));
    if (missing.success) return null;
  }
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
    throw new MarketplaceServiceError(
      503,
      `OpenSea ${operation} unavailable: provider HTTP 429 (rate limit).`,
      "OPENSEA_RATE_LIMITED",
      true,
      retryAfter,
    );
  }
  if (!response.ok) {
    const error =
      operation === "posting" && [400, 422].includes(response.status)
        ? await rejectedOpenSeaOrder(response)
        : new MarketplaceServiceError(
            503,
            `OpenSea ${operation} unavailable: provider HTTP ${response.status}.`,
            [401, 403].includes(response.status) ? "OPENSEA_AUTH_ERROR" : "OPENSEA_UNAVAILABLE",
            response.status === 408 || response.status === 409 || response.status >= 500,
          );
    console.warn("[marketplace-opensea] Provider request failed", {
      operation,
      status: response.status,
      requestId: error.requestId,
      code: error.code,
    });
    throw error;
  }
  try {
    return parseOpenSeaJson(await response.text());
  } catch {
    throw new MarketplaceServiceError(
      503,
      `OpenSea ${operation} unavailable: invalid JSON response.`,
      "OPENSEA_INVALID_RESPONSE",
      true,
    );
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

function parseOpenSeaPage(raw: unknown) {
  const response = z
    .object({
      listings: z.array(z.unknown()).max(200),
      next: z.string().max(1024).nullish(),
    })
    .safeParse(raw);
  if (!response.success) throw marketplaceUnavailable("OpenSea returned an invalid page.");
  const offers: Array<{ tokenId: string; offer: MarketplaceOffer }> = [];
  let partial = false;
  for (const rawListing of response.data.listings) {
    try {
      const listing = normalizeOpenSeaListing(rawListing);
      if (listing) offers.push(listing);
      else if (
        z.object({ status: z.literal("ACTIVE"), chain: z.literal("base") }).safeParse(rawListing)
          .success
      ) {
        // An unsupported active order is not evidence that the NFT is unlisted.
        partial = true;
      }
    } catch {
      partial = true;
    }
  }
  return { offers, nextCursor: response.data.next || null, partial };
}

export const listOpenSeaMarketplace = unstable_cache(
  async (cursor?: string) => {
    const byToken = new Map<string, { tokenId: string; offer: MarketplaceOffer }>();
    let nextCursor: string | null = cursor ?? null;
    let partial = false;
    // The best feed is price-ascending, but may include several orders for one NFT.
    // Bound provider work while filling a page without dropping unconsumed orders.
    for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
      const parameters = new URLSearchParams({
        limit: String(MARKETPLACE_PAGE_SIZE - byToken.size),
      });
      if (nextCursor) parameters.set("next", nextCursor);
      let page: ReturnType<typeof parseOpenSeaPage>;
      try {
        page = parseOpenSeaPage(
          await openSeaRequest(`listings/collection/gnars-dao/best?${parameters}`),
        );
      } catch (error) {
        if (pageIndex === 0) throw error;
        partial = true;
        break;
      }
      partial ||= page.partial;
      for (const row of page.offers) {
        const existing = byToken.get(row.tokenId);
        if (!existing || BigInt(row.offer.priceWei) < BigInt(existing.offer.priceWei))
          byToken.set(row.tokenId, row);
      }
      const previous = nextCursor;
      nextCursor = page.nextCursor;
      if (!nextCursor || nextCursor === previous || byToken.size >= MARKETPLACE_PAGE_SIZE) break;
    }
    return { offers: [...byToken.values()], nextCursor, partial };
  },
  ["marketplace-opensea-best-v2"],
  { revalidate: 30, tags: [MARKETPLACE_CACHE_TAG, MARKETPLACE_OPENSEA_ORDERS_CACHE_TAG] },
);

/** One owner-filtered request enriches all inventory cards, without per-NFT API calls. */
export const getOpenSeaOwnerListings = unstable_cache(
  async (owner: Address) => {
    const parameters = new URLSearchParams({ maker: owner.toLowerCase(), limit: "200" });
    const page = parseOpenSeaPage(
      await openSeaRequest(`listings/collection/gnars-dao/all?${parameters}`),
    );
    return {
      offers: page.offers.filter((row) => row.offer.seller.toLowerCase() === owner.toLowerCase()),
      partial: page.partial || page.nextCursor !== null,
    };
  },
  ["marketplace-opensea-owner-v1"],
  { revalidate: 30, tags: [MARKETPLACE_CACHE_TAG, MARKETPLACE_OPENSEA_ORDERS_CACHE_TAG] },
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

export const listOpenSeaOwnerMarketplace = unstable_cache(
  async (owner: Address, cursor?: string) => {
    const parameters = new URLSearchParams({
      maker: owner.toLowerCase(),
      limit: String(MARKETPLACE_PAGE_SIZE),
    });
    if (cursor) parameters.set("next", cursor);
    const page = parseOpenSeaPage(
      await openSeaRequest(`listings/collection/gnars-dao/all?${parameters}`),
    );
    return {
      ...page,
      offers: page.offers.filter((row) => row.offer.seller.toLowerCase() === owner.toLowerCase()),
    };
  },
  ["marketplace-opensea-owner-page-v1"],
  { revalidate: 30, tags: [MARKETPLACE_CACHE_TAG, MARKETPLACE_OPENSEA_ORDERS_CACHE_TAG] },
);

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
  { revalidate: 30, tags: [MARKETPLACE_CACHE_TAG, MARKETPLACE_OPENSEA_ORDERS_CACHE_TAG] },
);

async function readOpenSeaListingFees() {
  const raw = await openSeaRequest("collections/gnars-dao");
  try {
    return parseOpenSeaListingFees(raw);
  } catch {
    throw marketplaceUnavailable("OpenSea collection fees could not be verified.");
  }
}

const cachedOpenSeaListingFees = unstable_cache(
  readOpenSeaListingFees,
  ["marketplace-opensea-listing-fees-v1"],
  { revalidate: 300, tags: [OPENSEA_FEES_CACHE_TAG] },
);

export async function getOpenSeaListingQuote(priceWei: string) {
  const fees = await cachedOpenSeaListingFees();
  try {
    return buildOpenSeaListingQuote(priceWei, fees);
  } catch {
    throw new RequestSecurityError(400, "Price is too small for the required OpenSea fees.");
  }
}

async function readOpenSeaRawOrder(orderHash: string, allowNotFound = false) {
  const raw = await openSeaRequest(
    `orders/chain/base/protocol/${SEAPORT_ADDRESS}/${orderHash}`,
    undefined,
    allowNotFound,
  );
  if (raw === null) return null;
  const parsed = z.object({ order: z.object({}).passthrough() }).safeParse(raw);
  if (!parsed.success) throw marketplaceUnavailable("OpenSea returned an invalid order response.");
  return parsed.data.order;
}

/** Cancellation remains possible after an order has expired or left the active listing feed. */
export async function getOpenSeaCancellationOrder(orderHash: string) {
  const raw = await readOpenSeaRawOrder(orderHash, true);
  if (!raw) throw new RequestSecurityError(404, "Listing was not found.");
  const identity = z
    .object({
      protocol_data: z.object({
        parameters: z.object({
          offerer: marketplaceAddressSchema,
          offer: z.array(itemSchema).length(1),
        }),
      }),
    })
    .safeParse(raw);
  if (!identity.success) throw marketplaceUnavailable("OpenSea returned an invalid order.");
  try {
    getOpenSeaCancellation(raw, {
      orderHash: orderHash as Hex,
      seller: getAddress(identity.data.protocol_data.parameters.offerer),
      tokenId: identity.data.protocol_data.parameters.offer[0].identifierOrCriteria,
    });
  } catch {
    throw marketplaceUnavailable("OpenSea order could not be verified.");
  }
  return raw;
}

function verifyPublishedOpenSeaOrder(raw: unknown, listing: SignedListing): MarketplaceOffer {
  const orderHash = getListingOrderHash(listing.parameters);
  const tokenId = listing.parameters.offer[0].identifierOrCriteria;
  const normalized = normalizeOpenSeaListing(raw);
  if (
    !normalized ||
    normalized.offer.orderHash.toLowerCase() !== orderHash.toLowerCase() ||
    normalized.tokenId !== tokenId ||
    normalized.offer.seller.toLowerCase() !== listing.parameters.offerer.toLowerCase() ||
    normalized.offer.priceWei !== getListingPriceWei(listing).toString() ||
    normalized.offer.expiresAt !== Number(listing.parameters.endTime)
  )
    throw marketplaceUnavailable("OpenSea publication could not be verified.");
  try {
    getOpenSeaCancellation(raw, { orderHash, tokenId, seller: listing.parameters.offerer });
  } catch {
    throw marketplaceUnavailable("OpenSea publication could not be verified.");
  }
  return normalized.offer;
}

export async function publishOpenSeaListing(raw: unknown): Promise<MarketplaceOffer> {
  let listing: SignedListing;
  try {
    listing = validateListingStructure(raw, { source: "opensea" });
    getListingPriceWei(listing);
  } catch {
    throw new RequestSecurityError(400, "Invalid OpenSea listing.");
  }
  if (!marketplaceOpenSeaConfigured()) throw marketplaceUnavailable("OpenSea is not configured.");
  try {
    await validateListingOnchain(marketplaceClient, listing, {
      source: "opensea",
      requireApproval: true,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      ["Invalid owner signature", "Smart account does not support this Seaport signature"].includes(
        error.message,
      )
    ) {
      throw new MarketplaceServiceError(
        422,
        "The saved order's signature could not be verified for this wallet.",
        "OPENSEA_SIGNATURE_INVALID",
        false,
      );
    }
    if (error instanceof Error && error.message === "Seaport order hash mismatch") {
      throw new MarketplaceServiceError(
        422,
        "The signed order could not be verified against Seaport.",
        "OPENSEA_ORDER_REJECTED",
        false,
      );
    }
    if (
      error instanceof Error &&
      /^Listing is (cancelled|filled|expired|invalid-owner|invalid-counter|unapproved)$/.test(
        error.message,
      )
    ) {
      throw new MarketplaceServiceError(
        409,
        "This signed listing is no longer valid onchain. Verify its status before starting another listing.",
        "ORDER_NO_LONGER_VALID",
        false,
      );
    }
    throw error;
  }
  const hash = getListingOrderHash(listing.parameters);
  // A response can be lost after acceptance. Only the identical verified order makes a retry succeed.
  const existing = await readOpenSeaRawOrder(hash, true);
  if (existing) return verifyPublishedOpenSeaOrder(existing, listing);
  const fees = await readOpenSeaListingFees();
  try {
    const quote = buildOpenSeaListingQuote(getListingPriceWei(listing).toString(), fees);
    validateOpenSeaListingFees(listing, quote);
  } catch {
    revalidateTag(OPENSEA_FEES_CACHE_TAG, { expire: 0 });
    throw new MarketplaceServiceError(
      409,
      "OpenSea fees changed. Cancel the saved signed order before reviewing a new listing.",
      "OPENSEA_FEES_CHANGED",
      false,
    );
  }
  const accepted = await fetchOpenSea(
    "orders/base/seaport/listings",
    {
      parameters: {
        ...listing.parameters,
        totalOriginalConsiderationItems: listing.parameters.consideration.length,
      },
      signature: listing.signature,
      protocol_address: SEAPORT_ADDRESS,
    },
    false,
    "posting",
  );
  // Since May 2026 OpenSea returns the accepted Listing directly. Validate this
  // response before an unnecessary lookup that may lag the posting endpoint.
  if (orderSchema.safeParse(accepted).success)
    return verifyPublishedOpenSeaOrder(accepted, listing);
  const published = await readOpenSeaRawOrder(hash, true);
  if (!published)
    throw new MarketplaceServiceError(
      503,
      "OpenSea publication has not been confirmed. Retry this listing.",
      "PUBLICATION_UNCONFIRMED",
      true,
    );
  return verifyPublishedOpenSeaOrder(published, listing);
}

export async function reconcileOpenSeaOrder(orderHash: Hex) {
  const [, cancelled, filled, size] = await marketplaceClient.readContract({
    address: SEAPORT_ADDRESS,
    abi: seaportAbi,
    functionName: "getOrderStatus",
    args: [orderHash],
  });
  return { status: cancelled ? "cancelled" : size > 0n && filled >= size ? "filled" : "active" };
}

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
