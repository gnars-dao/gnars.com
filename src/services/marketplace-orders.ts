import "server-only";
import { createHash } from "node:crypto";
import { unstable_cache } from "next/cache";
import { Pool } from "pg";
import { erc721Abi, isAddressEqual, type Address, type Hex } from "viem";
import { DAO_ADDRESSES } from "@/lib/config";
import {
  getListingOrderHash,
  getListingPriceWei,
  getListingStatus,
  SEAPORT_ADDRESS,
  seaportAbi,
  validateListingOnchain,
  validateListingStructure,
  type ListingStatus,
  type SignedListing,
} from "@/lib/marketplace/seaport";
import { marketplaceDatabaseConnection } from "@/lib/server/marketplace-database";
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
    ...marketplaceDatabaseConnection(connectionString, process.env.MARKETPLACE_DATABASE_SSL_CA),
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

type StoredOrder = {
  id: string;
  signed_order: unknown;
  order_hash: Hex;
  status: string;
  checked_at?: Date | string;
  candidate_count?: string;
};

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

export async function listMarketplaceOrders(
  before?: string,
  tokenIds?: string[],
  seller?: Address,
) {
  if (!(await marketplaceStorageReady()))
    throw marketplaceUnavailable("Marketplace order storage is unavailable.");
  const result = await database().query<StoredOrder>(
    `${tokenIds ? "WITH candidates AS (" : ""}
     SELECT id, order_hash, signed_order, status, checked_at
     ${tokenIds ? ", ROW_NUMBER() OVER (PARTITION BY token_id ORDER BY price_wei, id DESC) AS rank, COUNT(*) OVER (PARTITION BY token_id) AS candidate_count" : ""}
     FROM marketplace_orders
     WHERE chain_id = 8453 AND status IN ('active', 'invalid-owner', 'unapproved') AND expires_at > $1
     ${before ? "AND id < $2" : ""}
     ${tokenIds ? `AND token_id = ANY($${before ? 3 : 2}::numeric[])` : ""}
     ${seller ? `AND seller = $${2 + Number(Boolean(before)) + Number(Boolean(tokenIds))}` : ""}
     ${tokenIds ? ") SELECT id, order_hash, signed_order, status, checked_at, candidate_count FROM candidates WHERE rank <= 25 ORDER BY id DESC" : `ORDER BY id DESC LIMIT ${MARKETPLACE_PAGE_SIZE}`}`,
    [
      Math.floor(Date.now() / 1000),
      ...(before ? [before] : []),
      ...(tokenIds ? [tokenIds] : []),
      ...(seller ? [seller.toLowerCase()] : []),
    ],
  );
  const offers: Array<{ tokenId: string; offer: MarketplaceOffer }> = [];
  const stale: Array<{ row: StoredOrder; listing: SignedListing }> = [];
  let partial = result.rows.some((row) => Number(row.candidate_count) > 25);
  const now = Date.now();
  for (const row of result.rows) {
    try {
      const listing = validateListingStructure(row.signed_order, { allowExpired: true });
      if (getListingOrderHash(listing.parameters).toLowerCase() !== row.order_hash.toLowerCase())
        throw new Error("Stored order identity mismatch");
      if (BigInt(listing.parameters.endTime) <= BigInt(Math.floor(now / 1000))) continue;
      const checked = row.checked_at ? new Date(row.checked_at).getTime() : 0;
      if (checked <= now && now - checked < 15_000) {
        if (row.status === "active")
          offers.push({
            tokenId: listing.parameters.offer[0].identifierOrCriteria,
            offer: localMarketplaceOffer(listing),
          });
      } else stale.push({ row, listing });
    } catch {
      partial = true;
    }
  }

  if (stale.length > 0) {
    // Catalogue reads share one chain snapshot and batched RPC, not one full
    // validation + SQL read/write per card. Execution still validates afresh.
    const [chainId, block] = await Promise.all([
      marketplaceClient.getChainId(),
      marketplaceClient.getBlock(),
    ]);
    if (chainId !== 8453) throw marketplaceUnavailable("Marketplace RPC is not on Base.");
    const updates: Array<{ hash: Hex; status: ListingStatus }> = [];
    for (let offset = 0; offset < stale.length; offset += 24) {
      const batch = stale.slice(offset, offset + 24);
      const reads = await marketplaceClient
        .multicall({
          allowFailure: true,
          blockNumber: block.number,
          contracts: batch.flatMap(({ listing, row }) => [
            {
              address: SEAPORT_ADDRESS,
              abi: seaportAbi,
              functionName: "getOrderStatus",
              args: [row.order_hash],
            },
            {
              address: SEAPORT_ADDRESS,
              abi: seaportAbi,
              functionName: "getCounter",
              args: [listing.parameters.offerer],
            },
            {
              address: DAO_ADDRESSES.token,
              abi: erc721Abi,
              functionName: "ownerOf",
              args: [BigInt(listing.parameters.offer[0].identifierOrCriteria)],
            },
            {
              address: DAO_ADDRESSES.token,
              abi: erc721Abi,
              functionName: "getApproved",
              args: [BigInt(listing.parameters.offer[0].identifierOrCriteria)],
            },
            {
              address: DAO_ADDRESSES.token,
              abi: erc721Abi,
              functionName: "isApprovedForAll",
              args: [listing.parameters.offerer, SEAPORT_ADDRESS],
            },
          ]),
        })
        .catch(() => null);
      if (!reads) {
        partial = true;
        continue;
      }
      for (const [index, { row, listing }] of batch.entries()) {
        const values = reads.slice(index * 5, index * 5 + 5);
        if (values.length !== 5 || values.some((read) => read.status !== "success")) {
          partial = true;
          continue;
        }
        const [order, counter, owner, approval, approvedAll] = values.map(
          (read) => read.result,
        ) as [
          readonly [boolean, boolean, bigint, bigint],
          bigint,
          `0x${string}`,
          `0x${string}`,
          boolean,
        ];
        const p = listing.parameters;
        const status: ListingStatus = order[1]
          ? "cancelled"
          : order[2] > 0n
            ? "filled"
            : BigInt(p.endTime) <= block.timestamp
              ? "expired"
              : counter !== BigInt(p.counter)
                ? "invalid-counter"
                : !isAddressEqual(owner, p.offerer)
                  ? "invalid-owner"
                  : !isAddressEqual(approval, SEAPORT_ADDRESS) && !approvedAll
                    ? "unapproved"
                    : "active";
        if (BigInt(p.startTime) > block.timestamp) {
          partial = true;
          continue;
        }
        updates.push({ hash: row.order_hash, status });
        if (status === "active")
          offers.push({
            tokenId: p.offer[0].identifierOrCriteria,
            offer: localMarketplaceOffer(listing),
          });
      }
    }
    if (updates.length > 0) {
      try {
        await database().query(
          `UPDATE marketplace_orders AS orders SET status = checked.status, checked_at = NOW()
           FROM UNNEST($1::text[], $2::text[]) AS checked(order_hash, status)
           WHERE orders.chain_id = 8453 AND orders.order_hash = checked.order_hash`,
          [updates.map((update) => update.hash), updates.map((update) => update.status)],
        );
      } catch {
        // Already verified offers remain readable if persisting their snapshot fails.
        partial = true;
      }
    }
  }
  return {
    offers,
    partial,
    nextCursor:
      !tokenIds && result.rows.length === MARKETPLACE_PAGE_SIZE ? result.rows.at(-1)!.id : null,
  };
}
