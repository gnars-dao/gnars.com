import "server-only";
import { createHash } from "node:crypto";
import { unstable_cache } from "next/cache";
import { Pool } from "pg";
import type { Hex } from "viem";
import {
  getListingOrderHash,
  getListingPriceWei,
  getListingStatus,
  SEAPORT_ADDRESS,
  validateListingOnchain,
  validateListingStructure,
  type SignedListing,
} from "@/lib/marketplace/seaport";
import { RequestSecurityError } from "@/lib/server/request-security";
import {
  MARKETPLACE_PAGE_SIZE,
  marketplaceClient,
  marketplaceUnavailable,
} from "@/services/marketplace-common";
import type { MarketplaceOffer } from "@/types/marketplace";

let pool: Pool | undefined;
function databaseUrl() {
  return (
    process.env.MARKETPLACE_DATABASE_URL ||
    process.env.ROUNDS_DATABASE_URL ||
    process.env.DATABASE_PUBLIC_URL ||
    process.env.DATABASE_URL
  );
}
export function marketplaceStorageConfigured() {
  return Boolean(databaseUrl());
}

function database() {
  const connectionString = databaseUrl();
  if (!connectionString)
    throw marketplaceUnavailable("Marketplace order storage is not configured.");
  pool ??= new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    statement_timeout: 5000,
    query_timeout: 6000,
  });
  return pool;
}

export const marketplaceStorageReady = unstable_cache(
  async () => {
    if (!databaseUrl()) return false;
    try {
      await database().query(
        "SELECT id, chain_id, order_hash, token_id, seller, price_wei, expires_at, signed_order, status, checked_at FROM marketplace_orders LIMIT 0",
      );
      await database().query(
        "SELECT bucket, hits, expires_at FROM marketplace_rate_limits LIMIT 0",
      );
      const permissions = await database().query<{ writable: boolean }>(`SELECT
        has_table_privilege(current_user, 'marketplace_orders', 'SELECT') AND
        has_table_privilege(current_user, 'marketplace_orders', 'INSERT') AND
        has_table_privilege(current_user, 'marketplace_orders', 'UPDATE') AND
        has_sequence_privilege(current_user, pg_get_serial_sequence('marketplace_orders', 'id'), 'USAGE') AND
        has_table_privilege(current_user, 'marketplace_rate_limits', 'SELECT') AND
        has_table_privilege(current_user, 'marketplace_rate_limits', 'INSERT') AND
        has_table_privilege(current_user, 'marketplace_rate_limits', 'UPDATE') AND
        has_table_privilege(current_user, 'marketplace_rate_limits', 'DELETE') AS writable`);
      return permissions.rows[0]?.writable === true;
    } catch {
      return false;
    }
  },
  ["marketplace-storage-ready-v1"],
  { revalidate: 60 },
);

/** Durable budgets protect paid/RPC work across every serverless instance. */
export async function enforceMarketplaceBudget(
  request: Request,
  operation: "create" | "fulfillment" | "reconcile",
) {
  if (!(await marketplaceStorageReady()))
    throw marketplaceUnavailable("Marketplace transaction storage is unavailable.");
  const now = Math.floor(Date.now() / 1000);
  const minute = Math.floor(now / 60);
  const ip = request.headers.get("x-vercel-forwarded-for") ?? "local";
  const limits = operation === "fulfillment" ? [20, 40] : [10, 60];
  for (const [index, subject] of [ip, "global"].entries()) {
    const key = createHash("sha256")
      .update(`${operation}:${index}:${subject}:${minute}`)
      .digest("hex");
    const result = await database().query(
      `INSERT INTO marketplace_rate_limits (bucket, hits, expires_at) VALUES ($1, 1, $2)
       ON CONFLICT (bucket) DO UPDATE SET hits = marketplace_rate_limits.hits + 1
       WHERE marketplace_rate_limits.hits < $3 RETURNING hits`,
      [key, (minute + 1) * 60, limits[index]],
    );
    if (result.rowCount === 0)
      throw new RequestSecurityError(429, "Marketplace request limit reached.", 60 - (now % 60));
  }
  await database().query("DELETE FROM marketplace_rate_limits WHERE expires_at < $1", [now - 3600]);
}

/** Count only outbound cache misses, across instances when marketplace storage is ready. */
export async function enforceOpenSeaProviderBudget(operation: "read" | "fulfillment" | "posting") {
  if (!marketplaceStorageConfigured()) return;
  if (!(await marketplaceStorageReady())) return;
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / 30);
  // A rolling minute intersects at most three buckets: <=90 reads / 45 per write category.
  // Leave headroom because OpenSea shares the account's quota across all API keys.
  const limit = operation === "read" ? 30 : 15;
  const bucket = createHash("sha256")
    .update(`opensea-provider:${operation}:${window}`)
    .digest("hex");
  const result = await database().query(
    `INSERT INTO marketplace_rate_limits (bucket, hits, expires_at) VALUES ($1, 1, $2)
     ON CONFLICT (bucket) DO UPDATE SET hits = marketplace_rate_limits.hits + 1
     WHERE marketplace_rate_limits.hits < $3 RETURNING hits`,
    [bucket, (window + 1) * 30, limit],
  );
  if (result.rowCount === 0)
    throw new RequestSecurityError(429, "OpenSea request limit reached.", 30 - (now % 30));
  if (result.rows[0]?.hits === 1)
    await database().query("DELETE FROM marketplace_rate_limits WHERE expires_at < $1", [
      now - 3600,
    ]);
}

type StoredOrder = { id: string; signed_order: unknown; order_hash: Hex; status: string };

export function localMarketplaceOffer(listing: SignedListing): MarketplaceOffer {
  const orderHash = getListingOrderHash(listing.parameters);
  return {
    id: `gnars:${orderHash}`,
    source: "gnars",
    orderHash,
    protocolAddress: SEAPORT_ADDRESS,
    seller: listing.parameters.offerer,
    priceWei: getListingPriceWei(listing).toString(),
    currency: "ETH",
    expiresAt: Number(listing.parameters.endTime),
  };
}

export async function saveMarketplaceOrder(raw: unknown) {
  if (!(await marketplaceStorageReady()))
    throw marketplaceUnavailable("Marketplace order storage is unavailable.");
  const listing = validateListingStructure(raw);
  const { orderHash } = await validateListingOnchain(marketplaceClient, listing, {
    requireApproval: true,
  });
  const offer = localMarketplaceOffer(listing);
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    // Serialize one seller's quota check with insertion across server instances.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      listing.parameters.offerer.toLowerCase(),
    ]);
    const existing = await client.query(
      "SELECT order_hash FROM marketplace_orders WHERE chain_id = 8453 AND order_hash = $1",
      [orderHash.toLowerCase()],
    );
    if (existing.rowCount === 0) {
      const count = await client.query<{ count: string }>(
        "SELECT count(*) FROM marketplace_orders WHERE seller = $1 AND status IN ('active', 'invalid-owner', 'unapproved') AND expires_at > $2",
        [listing.parameters.offerer.toLowerCase(), Math.floor(Date.now() / 1000)],
      );
      if (Number(count.rows[0].count) >= 25)
        throw new RequestSecurityError(429, "Active listing limit reached.");
      await client.query(
        `INSERT INTO marketplace_orders (chain_id, order_hash, token_id, seller, price_wei, expires_at, signed_order)
         VALUES (8453, $1, $2, $3, $4, $5, $6::jsonb) ON CONFLICT (chain_id, order_hash) DO NOTHING`,
        [
          orderHash.toLowerCase(),
          listing.parameters.offer[0].identifierOrCriteria,
          listing.parameters.offerer.toLowerCase(),
          offer.priceWei,
          offer.expiresAt,
          JSON.stringify(listing),
        ],
      );
    }
    await client.query("COMMIT");
    return offer;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getMarketplaceOrder(orderHash: string): Promise<SignedListing> {
  const result = await database().query<StoredOrder>(
    "SELECT id, order_hash, signed_order, status FROM marketplace_orders WHERE chain_id = 8453 AND order_hash = $1",
    [orderHash.toLowerCase()],
  );
  if (!result.rows[0]) throw new RequestSecurityError(404, "Listing was not found.");
  const listing = validateListingStructure(result.rows[0].signed_order, { allowExpired: true });
  if (getListingOrderHash(listing.parameters).toLowerCase() !== orderHash.toLowerCase()) {
    throw marketplaceUnavailable("Stored listing could not be verified.");
  }
  return listing;
}

export async function reconcileMarketplaceOrder(orderHash: string) {
  const listing = await getMarketplaceOrder(orderHash);
  // No client-supplied status or transaction claim can cancel/fill an order.
  const status = await getListingStatus(marketplaceClient, listing);
  await database().query(
    "UPDATE marketplace_orders SET status = $2, checked_at = NOW() WHERE chain_id = 8453 AND order_hash = $1",
    [orderHash.toLowerCase(), status],
  );
  return { listing, status };
}

export async function listMarketplaceOrders(before?: string, tokenIds?: string[]) {
  if (!(await marketplaceStorageReady()))
    throw marketplaceUnavailable("Marketplace order storage is unavailable.");
  const result = await database().query<StoredOrder>(
    `SELECT id, order_hash, signed_order, status FROM marketplace_orders
     WHERE chain_id = 8453 AND status IN ('active', 'invalid-owner', 'unapproved') AND expires_at > $1
     ${before ? "AND id < $2" : ""}
     ${tokenIds ? `AND token_id = ANY($${before ? 3 : 2}::numeric[])` : ""}
     ORDER BY id DESC LIMIT ${MARKETPLACE_PAGE_SIZE}`,
    [Math.floor(Date.now() / 1000), ...(before ? [before] : []), ...(tokenIds ? [tokenIds] : [])],
  );
  const offers: Array<{ tokenId: string; offer: MarketplaceOffer }> = [];
  for (let index = 0; index < result.rows.length; index += 3) {
    const rows = await Promise.all(
      result.rows.slice(index, index + 3).map(async (row) => {
        const { listing, status } = await reconcileMarketplaceOrder(row.order_hash);
        return status === "active"
          ? {
              tokenId: listing.parameters.offer[0].identifierOrCriteria,
              offer: localMarketplaceOffer(listing),
            }
          : null;
      }),
    );
    offers.push(...rows.filter((row) => row !== null));
  }
  return {
    offers,
    nextCursor: result.rows.length === MARKETPLACE_PAGE_SIZE ? result.rows.at(-1)!.id : null,
  };
}
