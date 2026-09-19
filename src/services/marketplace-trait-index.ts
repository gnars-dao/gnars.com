import "server-only";
import { unstable_cache } from "next/cache";
import { Pool } from "pg";
import { DAO_ADDRESSES } from "@/lib/config";
import {
  traitIndexComplete,
  validateTraitIndex,
  type TraitIndex,
} from "@/lib/marketplace/trait-index";
import { marketplaceDatabaseConnection } from "@/lib/server/marketplace-database";
import { RequestSecurityError } from "@/lib/server/request-security";
import { marketplaceUnavailable } from "./marketplace-common";

let pool: Pool | undefined;
function database() {
  const connectionString =
    process.env.MARKETPLACE_DATABASE_URL ||
    process.env.ROUNDS_DATABASE_URL ||
    process.env.DATABASE_PUBLIC_URL ||
    process.env.DATABASE_URL;
  if (!connectionString)
    throw marketplaceUnavailable("Marketplace trait storage is not configured.");
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

const readSnapshot = unstable_cache(
  async (snapshotId?: string): Promise<TraitIndex> => {
    try {
      const result = await database().query<{
        snapshot: unknown;
        block_hash: string;
        block_number: string;
      }>(
        `SELECT snapshot, block_hash, block_number::text FROM public.marketplace_trait_snapshots
       WHERE chain_id = 8453 AND collection_address = $1 ${snapshotId ? "AND block_hash = $2" : ""}
       ORDER BY block_number DESC, block_hash ASC LIMIT 1`,
        [DAO_ADDRESSES.token.toLowerCase(), ...(snapshotId ? [snapshotId] : [])],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Missing snapshot");
      const index = validateTraitIndex(row.snapshot);
      if (
        !traitIndexComplete(index) ||
        index.collection !== DAO_ADDRESSES.token.toLowerCase() ||
        index.blockHash !== row.block_hash ||
        index.blockNumber !== row.block_number ||
        (snapshotId !== undefined && index.blockHash !== snapshotId)
      )
        throw new Error("Invalid snapshot");
      return index;
    } catch {
      throw marketplaceUnavailable("Marketplace trait snapshot is unavailable.");
    }
  },
  ["marketplace-trait-snapshot-v1"],
  { revalidate: 60 },
);

export function getMarketplaceTraitSnapshot(snapshotId?: string): Promise<TraitIndex> {
  if (snapshotId !== undefined && !/^0x[0-9a-f]{64}$/.test(snapshotId))
    throw new RequestSecurityError(400, "Invalid marketplace trait snapshot.");
  return readSnapshot(snapshotId);
}

export async function getMarketplaceTraitFacets(snapshotId?: string) {
  const index = await getMarketplaceTraitSnapshot(snapshotId);
  const counts = new Map<string, Map<string, number>>();
  for (const entry of index.entries) {
    const seen = new Set<string>();
    for (const { type, value } of entry.traits!) {
      const key = JSON.stringify([type, value]);
      if (seen.has(key)) continue;
      seen.add(key);
      const values = counts.get(type) ?? new Map<string, number>();
      values.set(value, (values.get(value) ?? 0) + 1);
      counts.set(type, values);
    }
  }
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    snapshotId: index.blockHash,
    blockNumber: index.blockNumber,
    collectionAddress: index.collection,
    total: index.expectedCount,
    traits: [...counts]
      .sort(([a], [b]) => compare(a, b))
      .map(([type, values]) => ({
        type,
        values: [...values]
          .sort(([a], [b]) => compare(a, b))
          .map(([value, count]) => ({ value, count })),
      })),
  };
}
