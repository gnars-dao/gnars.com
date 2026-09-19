import "server-only";
import { Pool, type PoolClient } from "pg";
import { isAddress, zeroAddress } from "viem";
import { z } from "zod";
import { nativeHistoryCheckpointSchema } from "@/lib/marketplace/native-history-scan";
import { type MarketplaceActivityEvent } from "@/lib/marketplace/nft-insights";
import { getGnarsMarketplaceAddress } from "@/lib/marketplace/routing";
import { marketplaceDatabaseConnection } from "@/lib/server/marketplace-database";
import { RequestSecurityError } from "@/lib/server/request-security";
import { marketplaceUnavailable } from "./marketplace-common";

export type NativeActivityPosition = { blockNumber: string; logIndex: number };
export type NativeMarketplaceActivityEvent = MarketplaceActivityEvent &
  NativeActivityPosition & { source: "gnars-contract" };
const uint = z
  .string()
  .max(78)
  .regex(/^(0|[1-9]\d*)$/)
  .refine((v) => BigInt(v) < 2n ** 256n);
const address = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/)
  .refine((v) => v !== zeroAddress);
const hash = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/)
  .refine((v) => !/^0x0+$/.test(v));
const position = z.object({
  blockNumber: uint,
  logIndex: z.number().int().nonnegative().max(2147483647),
});
const eventSchema = position.extend({
  id: z.string(),
  chainId: z.literal(8453),
  protocolAddress: address,
  transactionHash: hash,
  blockHash: hash,
  timestamp: z.number().int().positive().max(8640000000000),
  sale: z.object({
    collectionAddress: address,
    tokenId: uint,
    seller: address,
    buyer: address,
    payment: z.object({
      tokenAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
      quantity: uint.refine((v) => BigInt(v) > 0n),
    }),
  }),
});
let pool: Pool | undefined;
function database() {
  const connectionString =
    process.env.MARKETPLACE_DATABASE_URL ||
    process.env.ROUNDS_DATABASE_URL ||
    process.env.DATABASE_PUBLIC_URL ||
    process.env.DATABASE_URL;
  if (!connectionString) throw marketplaceUnavailable("Native marketplace history is unavailable.");
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

export async function getNativeMarketplaceActivity(
  collection: string,
  tokenId: string,
  after?: NativeActivityPosition,
  throughBlock?: string,
): Promise<{
  events: NativeMarketplaceActivityEvent[];
  nextCursor: NativeActivityPosition | null;
  coverage: { startBlock: string; indexedThrough: string; blockHash: string };
}> {
  if (
    !isAddress(collection, { strict: false }) ||
    !uint.safeParse(tokenId).success ||
    (after && !position.safeParse(after).success) ||
    (throughBlock !== undefined && !uint.safeParse(throughBlock).success)
  )
    throw new RequestSecurityError(400, "Invalid native marketplace history request.");
  const protocol = getGnarsMarketplaceAddress()?.toLowerCase();
  if (!protocol) throw marketplaceUnavailable("Native marketplace history is unavailable.");
  let connection: PoolClient | undefined;
  try {
    connection = await database().connect();
    await connection.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const saved = await connection.query<{
      start_block: string;
      indexed_through: string | null;
      block_hash: string | null;
      finalized_target: string | null;
    }>(
      "SELECT start_block::text, indexed_through::text, block_hash, finalized_target::text FROM public.marketplace_history_checkpoints WHERE chain_id = 8453 AND protocol_address = $1",
      [protocol],
    );
    const row = saved.rows[0];
    if (!row) throw new Error("Missing checkpoint");
    const checkpoint = nativeHistoryCheckpointSchema.parse({
      version: 1,
      chainId: 8453,
      protocolAddress: protocol,
      startBlock: row.start_block,
      indexedThrough: row.indexed_through,
      blockHash: row.block_hash,
    });
    if (checkpoint.indexedThrough === null || checkpoint.blockHash === null)
      throw new Error("Uninitialized history");
    if (
      !uint.safeParse(row.finalized_target).success ||
      BigInt(checkpoint.indexedThrough) < BigInt(row.finalized_target!)
    )
      throw new Error("History backfill is incomplete");
    const through = throughBlock ?? checkpoint.indexedThrough;
    if (
      BigInt(through) > BigInt(checkpoint.indexedThrough) ||
      BigInt(through) < BigInt(checkpoint.startBlock) ||
      (after &&
        (BigInt(after.blockNumber) > BigInt(through) ||
          BigInt(after.blockNumber) < BigInt(checkpoint.startBlock)))
    )
      throw new Error("Invalid history coverage");
    const rows = await connection.query<{
      event: unknown;
      block_number: string;
      log_index: number;
      transaction_hash: string;
      block_hash: string;
    }>(
      `SELECT event, block_number::text, log_index, transaction_hash, block_hash FROM public.marketplace_history_events WHERE chain_id = 8453 AND protocol_address = $1 AND collection_address = $2 AND token_id = $3 AND block_number >= $4 AND block_number <= $5 ${after ? "AND (block_number, log_index) < ($6::numeric, $7::integer)" : ""} ORDER BY block_number DESC, log_index DESC LIMIT 21`,
      [
        protocol,
        collection.toLowerCase(),
        tokenId,
        checkpoint.startBlock,
        through,
        ...(after ? [after.blockNumber, after.logIndex] : []),
      ],
    );
    let previous = after;
    const events = rows.rows.map((row) => {
      const event = eventSchema.parse(row.event);
      if (
        event.protocolAddress !== protocol ||
        event.sale.collectionAddress !== collection.toLowerCase() ||
        event.sale.tokenId !== tokenId ||
        event.blockNumber !== row.block_number ||
        event.logIndex !== row.log_index ||
        event.transactionHash !== row.transaction_hash ||
        event.blockHash !== row.block_hash ||
        event.id !== `8453:${protocol}:${event.transactionHash}:${event.logIndex}` ||
        BigInt(event.blockNumber) < BigInt(checkpoint.startBlock) ||
        BigInt(event.blockNumber) > BigInt(through) ||
        (previous &&
          (BigInt(event.blockNumber) > BigInt(previous.blockNumber) ||
            (event.blockNumber === previous.blockNumber && event.logIndex >= previous.logIndex)))
      )
        throw new Error("Invalid history event identity");
      previous = event;
      const payment = event.sale.payment;
      const symbol =
        payment.tokenAddress === zeroAddress
          ? "ETH"
          : payment.tokenAddress === "0x4200000000000000000000000000000000000006"
            ? "WETH"
            : null;
      return {
        id: event.id,
        type: "sale" as const,
        source: "gnars-contract" as const,
        transactionHash: event.transactionHash,
        timestamp: event.timestamp,
        from: event.sale.seller,
        to: event.sale.buyer,
        blockNumber: event.blockNumber,
        logIndex: event.logIndex,
        ...(symbol ? { payment: { ...payment, symbol, decimals: 18 } } : {}),
      };
    });
    const page = events.slice(0, 20);
    const last = page.at(-1);
    await connection.query("COMMIT");
    return {
      events: page,
      nextCursor:
        events.length > 20 && last
          ? { blockNumber: last.blockNumber, logIndex: last.logIndex }
          : null,
      coverage: {
        startBlock: checkpoint.startBlock,
        indexedThrough: checkpoint.indexedThrough,
        blockHash: checkpoint.blockHash,
      },
    };
  } catch {
    throw marketplaceUnavailable("Native marketplace history is unavailable.");
  } finally {
    // Destroy on error too: any open read-only transaction is rolled back by PostgreSQL.
    connection?.release(true);
  }
}
