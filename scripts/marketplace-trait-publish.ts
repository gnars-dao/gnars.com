/** Administrative publication only; runtime credentials cannot write snapshots. */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";
import { DAO_ADDRESSES } from "../src/lib/config";
import { traitIndexComplete, validateTraitIndex } from "../src/lib/marketplace/trait-index";
import { marketplaceDatabaseConnection } from "../src/lib/server/marketplace-database";

export async function publishMarketplaceTraits() {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3) throw new Error("Expected snapshot file");
  const connectionString =
    process.env.MARKETPLACE_INDEXER_DATABASE_URL || process.env.MARKETPLACE_MIGRATION_DATABASE_URL;
  if (!connectionString) throw new Error("Explicit writer credentials required");
  const index = validateTraitIndex(JSON.parse(await readFile(path, "utf8")));
  if (index.collection !== DAO_ADDRESSES.token.toLowerCase() || !traitIndexComplete(index))
    throw new Error("Complete Gnars snapshot required");
  const rpc =
    process.env.BASE_RPC ||
    process.env.NEXT_PUBLIC_BASE_RPC_URL ||
    (process.env.ALCHEMY_API_KEY
      ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
      : undefined);
  if (!rpc) throw new Error("Base RPC required");
  const client = createPublicClient({
    chain: base,
    transport: http(rpc, { timeout: 15000, retryCount: 0 }),
  });
  if ((await client.getChainId()) !== 8453) throw new Error("Expected Base");
  const finalized = await client.getBlock({ blockTag: "finalized" });
  const block = await client.getBlock({ blockNumber: BigInt(index.blockNumber) });
  if (block.hash !== index.blockHash || block.number > finalized.number)
    throw new Error("Snapshot must be canonical and finalized");
  const supply = await client.readContract({
    address: DAO_ADDRESSES.token,
    abi: parseAbi(["function totalSupply() view returns (uint256)"]),
    functionName: "totalSupply",
    blockNumber: block.number,
  });
  if (
    supply !== BigInt(index.expectedCount) ||
    (await client.getBlock({ blockNumber: block.number })).hash !== index.blockHash
  )
    throw new Error("Snapshot supply or canonical block mismatch");
  const pool = new Pool({
    ...marketplaceDatabaseConnection(connectionString, process.env.MARKETPLACE_DATABASE_SSL_CA),
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    query_timeout: 20000,
  });
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query(
      "CREATE TEMP TABLE trait_publish_entries (ordinal integer PRIMARY KEY, entry jsonb NOT NULL) ON COMMIT DROP",
    );
    for (let offset = 0; offset < index.entries.length; offset += 100) {
      await connection.query(
        "INSERT INTO trait_publish_entries SELECT $2::integer + ordinality::integer, value FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY",
        [JSON.stringify(index.entries.slice(offset, offset + 100)), offset],
      );
    }
    const header = { ...index, entries: [] };
    const payload =
      "jsonb_set($4::jsonb, '{entries}', COALESCE((SELECT jsonb_agg(entry ORDER BY ordinal) FROM trait_publish_entries), '[]'::jsonb))";
    // Small bounded uploads avoid large protocol messages through the session pooler.
    await connection.query(
      `INSERT INTO public.marketplace_trait_snapshots
      (chain_id, collection_address, block_hash, block_number, snapshot)
      VALUES (8453, $1, $2, $3, ${payload}) ON CONFLICT DO NOTHING`,
      [index.collection, index.blockHash, index.blockNumber, JSON.stringify(header)],
    );
    const saved = await connection.query<{ identical: boolean }>(
      `SELECT snapshot = ${payload} AS identical
      FROM public.marketplace_trait_snapshots WHERE chain_id = 8453 AND collection_address = $1 AND block_hash = $2 AND block_number = $3`,
      [index.collection, index.blockHash, index.blockNumber, JSON.stringify(header)],
    );
    if (saved.rows[0]?.identical !== true) throw new Error("Published snapshot differs");
    await connection.query("COMMIT");
    console.log(
      JSON.stringify({
        snapshotId: index.blockHash,
        blockNumber: index.blockNumber,
        total: index.expectedCount,
      }),
    );
  } finally {
    connection.release(true);
    await pool.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  publishMarketplaceTraits().catch(() => {
    console.error(
      "Trait publication failed. Check writer configuration, snapshot and provider availability; no secrets logged.",
    );
    process.exitCode = 1;
  });
}
