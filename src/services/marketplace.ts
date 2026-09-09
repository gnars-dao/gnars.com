import "server-only";
import { unstable_cache } from "next/cache";
import { erc721Abi, type Address } from "viem";
import { z } from "zod";
import { DAO_ADDRESSES } from "@/lib/config";
import { getGnarsMarketplaceAddress } from "@/lib/marketplace/routing";
import { RequestSecurityError } from "@/lib/server/request-security";
import { getMarketplaceCatalogue, getMarketplaceMetadata } from "@/services/marketplace-catalogue";
import {
  MARKETPLACE_CACHE_TAG,
  MARKETPLACE_ORDERS_CACHE_TAG,
  marketplaceClient,
  marketplaceUintSchema,
} from "@/services/marketplace-common";
import {
  getOpenSeaOwnerListings,
  getOpenSeaTokenListing,
  listOpenSeaMarketplace,
  listOpenSeaOwnerMarketplace,
  marketplaceOpenSeaConfigured,
} from "@/services/marketplace-opensea";
import {
  listMarketplaceOrders,
  marketplaceContractStorageReady,
  marketplaceStorageConfigured,
  marketplaceStorageReady,
} from "@/services/marketplace-orders";
import type {
  MarketplaceAvailability,
  MarketplaceItem,
  MarketplacePage,
} from "@/types/marketplace";

export type MarketplaceView = "listings" | "catalogue" | "owned" | "selling";
const cursorSchema = z
  .object({
    view: z.enum(["listings", "catalogue", "owned", "selling"]),
    owner: z.string().optional(),
    opensea: z.string().max(1024).nullable().optional(),
    gnars: marketplaceUintSchema.nullable().optional(),
    "gnars-contract": marketplaceUintSchema.nullable().optional(),
    catalogue: marketplaceUintSchema.optional(),
  })
  .strict();

function decodeCursor(raw: string | undefined, view: MarketplaceView, owner?: Address) {
  if (!raw) return { view };
  try {
    if (raw.length > 2048) throw new Error("Cursor too long");
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    if (cursor.view !== view) throw new Error("Cursor view mismatch");
    if (view === "selling" && cursor.owner !== owner?.toLowerCase())
      throw new Error("Cursor owner mismatch");
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
  const custom = !!getGnarsMarketplaceAddress() && (await marketplaceContractStorageReady());
  const sources: Omit<MarketplacePage["sources"], "catalogue"> = {
    opensea: opensea ? { available: true } : { available: false, error: "not_configured" },
    gnars: local
      ? { available: true }
      : {
          available: false,
          error: marketplaceStorageConfigured() ? "unavailable" : "not_configured",
        },
    "gnars-contract": custom
      ? { available: true }
      : {
          available: false,
          error: getGnarsMarketplaceAddress() ? "unavailable" : "not_configured",
        },
  };
  return {
    sources,
    capabilities: {
      openseaBuy: opensea,
      openseaSell: opensea,
      openseaCancel: opensea,
      localTrading: local,
      customTrading: custom,
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
  if ((view === "owned" || view === "selling") && !owner)
    throw new RequestSecurityError(400, "Wallet address is required.");
  const cursor = decodeCursor(rawCursor, view, owner);
  const readiness = await getMarketplaceReadiness();
  const sources: MarketplacePage["sources"] = {
    catalogue: { available: true },
    ...readiness.sources,
  };
  let items: MarketplaceItem[] = [];
  let nextCursor: string | null = null;

  if (view === "catalogue" || view === "owned") {
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
    for (const source of ["gnars", "gnars-contract"] as const) {
      if (sources[source]?.available && items.length > 0) {
        try {
          const { offers, partial } = await cachedLocalOrders(
            undefined,
            items.map((item) => item.tokenId),
            undefined,
            source,
          );
          for (const row of offers)
            items.find((item) => item.tokenId === row.tokenId)?.offers.push(row.offer);
          if (partial) sources[source]!.partial = true;
        } catch {
          sources[source] = { available: false, error: "unavailable" };
        }
      }
    }
    if (sources.opensea.available && items.length > 0 && view === "owned" && owner) {
      try {
        const external = await getOpenSeaOwnerListings(owner);
        for (const row of external.offers)
          items.find((item) => item.tokenId === row.tokenId)?.offers.push(row.offer);
        if (external.partial) sources.opensea.partial = true;
      } catch {
        sources.opensea = { available: false, error: "unavailable" };
      }
    }
  } else {
    const external =
      sources.opensea.available && cursor.opensea !== null
        ? await (
            view === "selling" && owner
              ? listOpenSeaOwnerMarketplace(owner, cursor.opensea)
              : listOpenSeaMarketplace(cursor.opensea)
          ).catch(() => {
            sources.opensea = { available: false, error: "unavailable" };
            return null;
          })
        : null;
    const local =
      sources.gnars.available && cursor.gnars !== null
        ? await (
            view === "selling"
              ? cachedLocalOrders(cursor.gnars, undefined, owner)
              : cachedLocalOrders(cursor.gnars)
          ).catch(() => {
            sources.gnars = { available: false, error: "unavailable" };
            return null;
          })
        : null;
    const custom =
      sources["gnars-contract"]?.available && cursor["gnars-contract"] !== null
        ? await cachedLocalOrders(
            cursor["gnars-contract"],
            undefined,
            view === "selling" ? owner : undefined,
            "gnars-contract",
          ).catch(() => {
            sources["gnars-contract"] = { available: false, error: "unavailable" };
            return null;
          })
        : null;
    const offers = [
      ...(local?.offers ?? []),
      ...(custom?.offers ?? []),
      ...(external?.offers ?? []),
    ].filter((row) => row.offer.expiresAt > Date.now() / 1000);
    if (external?.partial) sources.opensea.partial = true;
    if (local?.partial) sources.gnars.partial = true;
    if (custom?.partial) sources["gnars-contract"]!.partial = true;
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
    // The indexer orders metadata by token ID; preserve the orderbook's ordering.
    items = tokens.map((tokenId) => byId.get(tokenId)!);
    if (external?.nextCursor || local?.nextCursor || custom?.nextCursor)
      nextCursor = encodeCursor({
        view,
        ...(view === "selling" ? { owner: owner!.toLowerCase() } : {}),
        // A failed source is not exhausted. Preserve its input cursor for recovery.
        opensea:
          sources.opensea.error === "unavailable" ? cursor.opensea : (external?.nextCursor ?? null),
        gnars: sources.gnars.error === "unavailable" ? cursor.gnars : (local?.nextCursor ?? null),
        "gnars-contract":
          sources["gnars-contract"]?.error === "unavailable"
            ? cursor["gnars-contract"]
            : (custom?.nextCursor ?? null),
      });
  }

  const unavailable = (source: MarketplaceAvailability) => !source.available;
  return {
    items,
    nextCursor,
    sources,
    capabilities: {
      openseaBuy: readiness.capabilities.openseaBuy && !unavailable(sources.opensea),
      openseaSell: readiness.capabilities.openseaSell,
      openseaCancel: readiness.capabilities.openseaCancel,
      localTrading: readiness.capabilities.localTrading && !unavailable(sources.gnars),
      customTrading:
        readiness.capabilities.customTrading && sources["gnars-contract"]?.available === true,
    },
  };
}

export async function loadMarketplaceToken(tokenId: string): Promise<MarketplacePage> {
  const readiness = await getMarketplaceReadiness();
  const sources: MarketplacePage["sources"] = {
    catalogue: { available: true },
    ...readiness.sources,
  };
  const metadata = await getMarketplaceMetadata([tokenId]).catch(() => {
    sources.catalogue = { available: false, error: "unavailable" };
    return [];
  });
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
  for (const source of ["gnars", "gnars-contract"] as const) {
    if (sources[source]?.available) {
      try {
        const { offers, partial } = await cachedLocalOrders(
          undefined,
          [tokenId],
          undefined,
          source,
        );
        item.offers.push(...offers.map((row) => row.offer));
        if (partial) sources[source]!.partial = true;
      } catch {
        sources[source] = { available: false, error: "unavailable" };
      }
    }
  }
  return {
    items: [item],
    ownershipVerified: true,
    nextCursor: null,
    sources,
    capabilities: {
      openseaBuy: readiness.capabilities.openseaBuy && sources.opensea.available,
      openseaSell: readiness.capabilities.openseaSell,
      openseaCancel: readiness.capabilities.openseaCancel,
      localTrading: readiness.capabilities.localTrading && sources.gnars.available,
      customTrading:
        readiness.capabilities.customTrading && sources["gnars-contract"]?.available === true,
    },
  };
}
