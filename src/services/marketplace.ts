import "server-only";
import { unstable_cache } from "next/cache";
import { erc721Abi, type Address } from "viem";
import { z } from "zod";
import { DAO_ADDRESSES } from "@/lib/config";
import { RequestSecurityError } from "@/lib/server/request-security";
import { getMarketplaceCatalogue, getMarketplaceMetadata } from "@/services/marketplace-catalogue";
import {
  MARKETPLACE_CACHE_TAG,
  MARKETPLACE_ORDERS_CACHE_TAG,
  marketplaceClient,
  marketplaceUintSchema,
} from "@/services/marketplace-common";
import {
  getOpenSeaTokenListing,
  listOpenSeaMarketplace,
  marketplaceOpenSeaConfigured,
} from "@/services/marketplace-opensea";
import {
  listMarketplaceOrders,
  marketplaceStorageConfigured,
  marketplaceStorageReady,
} from "@/services/marketplace-orders";
import type {
  MarketplaceAvailability,
  MarketplaceItem,
  MarketplacePage,
} from "@/types/marketplace";

export type MarketplaceView = "listings" | "catalogue" | "owned";
const cursorSchema = z
  .object({
    view: z.enum(["listings", "catalogue", "owned"]),
    opensea: z.string().max(1024).nullable().optional(),
    gnars: marketplaceUintSchema.nullable().optional(),
    catalogue: marketplaceUintSchema.optional(),
  })
  .strict();

function decodeCursor(raw: string | undefined, view: MarketplaceView) {
  if (!raw) return { view };
  try {
    if (raw.length > 2048) throw new Error("Cursor too long");
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    if (cursor.view !== view) throw new Error("Cursor view mismatch");
    return cursor;
  } catch {
    throw new RequestSecurityError(400, "Invalid marketplace cursor.");
  }
}
function encodeCursor(cursor: z.infer<typeof cursorSchema>) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export async function getMarketplaceReadiness() {
  const opensea = marketplaceOpenSeaConfigured();
  const local = await marketplaceStorageReady();
  const sources: Pick<MarketplacePage["sources"], "opensea" | "gnars"> = {
    opensea: opensea ? { available: true } : { available: false, error: "not_configured" },
    gnars: local
      ? { available: true }
      : {
          available: false,
          error: marketplaceStorageConfigured() ? "unavailable" : "not_configured",
        },
  };
  return {
    sources,
    capabilities: {
      openseaBuy: opensea,
      openseaSell: opensea,
      openseaCancel: opensea,
      localTrading: local,
    },
  };
}

const cachedLocalOrders = unstable_cache(listMarketplaceOrders, ["marketplace-orders-v1"], {
  revalidate: 15,
  tags: [MARKETPLACE_CACHE_TAG, MARKETPLACE_ORDERS_CACHE_TAG],
});

export async function loadMarketplacePage({
  view,
  owner,
  cursor: rawCursor,
}: {
  view: MarketplaceView;
  owner?: Address;
  cursor?: string;
}): Promise<MarketplacePage> {
  if (view === "owned" && !owner)
    throw new RequestSecurityError(400, "Wallet address is required.");
  const cursor = decodeCursor(rawCursor, view);
  const readiness = await getMarketplaceReadiness();
  const sources: MarketplacePage["sources"] = {
    catalogue: { available: true },
    ...readiness.sources,
  };
  let items: MarketplaceItem[] = [];
  let nextCursor: string | null = null;

  if (view !== "listings") {
    try {
      const catalogue = await getMarketplaceCatalogue(
        view === "owned" ? owner : undefined,
        cursor.catalogue,
      );
      items = catalogue.items;
      nextCursor = catalogue.nextCursor
        ? encodeCursor({ view, catalogue: catalogue.nextCursor })
        : null;
    } catch {
      sources.catalogue = { available: false, error: "unavailable" };
    }
    if (sources.gnars.available && items.length > 0) {
      try {
        const { offers } = await cachedLocalOrders(
          undefined,
          items.map((item) => item.tokenId),
        );
        for (const row of offers)
          items.find((item) => item.tokenId === row.tokenId)?.offers.push(row.offer);
      } catch {
        sources.gnars = { available: false, error: "unavailable" };
      }
    }
  } else {
    const external =
      sources.opensea.available && cursor.opensea !== null
        ? await listOpenSeaMarketplace(cursor.opensea).catch(() => {
            sources.opensea = { available: false, error: "unavailable" };
            return null;
          })
        : null;
    const local =
      sources.gnars.available && cursor.gnars !== null
        ? await cachedLocalOrders(cursor.gnars).catch(() => {
            sources.gnars = { available: false, error: "unavailable" };
            return null;
          })
        : null;
    const offers = [...(local?.offers ?? []), ...(external?.offers ?? [])].filter(
      (row) => row.offer.expiresAt > Date.now() / 1000,
    );
    const tokens = [...new Set(offers.map((row) => row.tokenId))];
    try {
      items = await getMarketplaceMetadata(tokens);
    } catch {
      sources.catalogue = { available: false, error: "unavailable" };
    }
    const byId = new Map(items.map((item) => [item.tokenId, item]));
    for (const row of offers) {
      if (!byId.has(row.tokenId))
        byId.set(row.tokenId, {
          tokenId: row.tokenId,
          name: `Gnar #${row.tokenId}`,
          image: null,
          owner: row.offer.seller,
          offers: [],
        });
      byId.get(row.tokenId)!.offers.push(row.offer);
    }
    items = [...byId.values()];
    if (external?.nextCursor || local?.nextCursor)
      nextCursor = encodeCursor({
        view,
        opensea: external?.nextCursor ?? null,
        gnars: local?.nextCursor ?? null,
      });
  }

  const unavailable = (source: MarketplaceAvailability) => !source.available;
  return {
    items,
    nextCursor,
    sources,
    capabilities: {
      openseaBuy: readiness.capabilities.openseaBuy && !unavailable(sources.opensea),
      openseaSell: readiness.capabilities.openseaSell && !unavailable(sources.opensea),
      openseaCancel: readiness.capabilities.openseaCancel && !unavailable(sources.opensea),
      localTrading: readiness.capabilities.localTrading && !unavailable(sources.gnars),
    },
  };
}

export async function loadMarketplaceToken(tokenId: string): Promise<MarketplacePage> {
  const readiness = await getMarketplaceReadiness();
  const sources: MarketplacePage["sources"] = {
    catalogue: { available: true },
    ...readiness.sources,
  };
  const metadata = await getMarketplaceMetadata([tokenId]);
  const owner = await marketplaceClient.readContract({
    address: DAO_ADDRESSES.token,
    abi: erc721Abi,
    functionName: "ownerOf",
    args: [BigInt(tokenId)],
  });
  const item: MarketplaceItem = {
    ...(metadata[0] ?? { tokenId, name: `Gnar #${tokenId}`, image: null }),
    owner,
    offers: [],
  };
  if (sources.opensea.available) {
    try {
      const listing = await getOpenSeaTokenListing(tokenId);
      if (
        listing &&
        listing.offer.seller.toLowerCase() === owner.toLowerCase() &&
        listing.offer.expiresAt > Date.now() / 1000
      )
        item.offers.push(listing.offer);
    } catch {
      sources.opensea = { available: false, error: "unavailable" };
    }
  }
  if (sources.gnars.available) {
    try {
      const { offers } = await cachedLocalOrders(undefined, [tokenId]);
      item.offers.push(...offers.map((row) => row.offer));
    } catch {
      sources.gnars = { available: false, error: "unavailable" };
    }
  }
  return {
    items: [item],
    nextCursor: null,
    sources,
    capabilities: {
      openseaBuy: readiness.capabilities.openseaBuy && sources.opensea.available,
      openseaSell: readiness.capabilities.openseaSell && sources.opensea.available,
      openseaCancel: readiness.capabilities.openseaCancel && sources.opensea.available,
      localTrading: readiness.capabilities.localTrading && sources.gnars.available,
    },
  };
}
