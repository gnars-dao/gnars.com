/** Administrative, read-only-chain ingestion. No local event files are trusted. */
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { createPublicClient, getAbiItem, http, toEventSelector, type Hex } from "viem";
import { base } from "viem/chains";
import {
  nativeHistoryCheckpointSchema,
  scanNativeHistoryRange,
} from "../src/lib/marketplace/native-history-scan";
import { getGnarsMarketplaceAddress } from "../src/lib/marketplace/routing";
import { sweepAbi } from "../src/lib/marketplace/sweep";
import { marketplaceDatabaseConnection } from "../src/lib/server/marketplace-database";

let stage = "configuration";
export async function syncNativeHistoryMain() {
  const [deploymentHash, stepsRaw = "100", rangeRaw = "2000"] = process.argv.slice(2);
  const steps = Number(stepsRaw),
    rangeSize = Number(rangeRaw);
  if (
    process.argv.length > 5 ||
    !/^0x[\da-fA-F]{64}$/.test(deploymentHash ?? "") ||
    !Number.isInteger(steps) ||
    steps < 1 ||
    steps > 1000 ||
    !Number.isInteger(rangeSize) ||
    rangeSize < 1 ||
    rangeSize > 10000
  )
    throw new Error("Expected deployment transaction, steps and range size");
  const connectionString = process.env.MARKETPLACE_MIGRATION_DATABASE_URL;
  const protocol = getGnarsMarketplaceAddress();
  const rpc =
    process.env.BASE_RPC ||
    process.env.NEXT_PUBLIC_BASE_RPC_URL ||
    (process.env.ALCHEMY_API_KEY
      ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
      : undefined);
  if (!connectionString || !protocol || !rpc)
    throw new Error("Explicit administrative credentials, marketplace and RPC required");
  const client = createPublicClient({
    chain: base,
    transport: http(rpc, { timeout: 15000, retryCount: 0 }),
  });
  stage = "deployment verification";
  if ((await client.getChainId()) !== 8453) throw new Error("Expected Base");
  const deployment = await client.getTransactionReceipt({ hash: deploymentHash as Hex });
  if (
    deployment.status !== "success" ||
    deployment.contractAddress?.toLowerCase() !== protocol.toLowerCase()
  )
    throw new Error("Wrong deployment");
  const canonical = await client.getBlock({ blockNumber: deployment.blockNumber });
  const finalized = await client.getBlock({ blockTag: "finalized" });
  if (canonical.hash !== deployment.blockHash || canonical.number > finalized.number)
    throw new Error("Deployment not canonical and finalized");
  const pool = new Pool({
    ...marketplaceDatabaseConnection(connectionString, process.env.MARKETPLACE_DATABASE_SSL_CA),
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    query_timeout: 20000,
  });
  const connection = await pool.connect();
  try {
    stage = "writer lock";
    const lock = await connection.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
      [`marketplace-history:8453:${protocol.toLowerCase()}`],
    );
    if (lock.rows[0]?.locked !== true) throw new Error("Another history writer is running");
    await connection.query(
      `INSERT INTO public.marketplace_history_checkpoints (chain_id, protocol_address, deployment_hash, start_block) VALUES (8453,$1,$2,$3) ON CONFLICT DO NOTHING`,
      [protocol.toLowerCase(), deploymentHash.toLowerCase(), String(deployment.blockNumber)],
    );
    const readCheckpoint = async () => {
      const saved = await connection.query<{
        deployment_hash: string;
        start_block: string;
        indexed_through: string | null;
        block_hash: string | null;
      }>(
        "SELECT deployment_hash, start_block::text, indexed_through::text, block_hash FROM public.marketplace_history_checkpoints WHERE chain_id = 8453 AND protocol_address = $1",
        [protocol.toLowerCase()],
      );
      const row = saved.rows[0];
      if (
        !row ||
        row.deployment_hash !== deploymentHash.toLowerCase() ||
        row.start_block !== String(deployment.blockNumber)
      )
        throw new Error("Checkpoint deployment differs");
      return nativeHistoryCheckpointSchema.parse({
        version: 1,
        chainId: 8453,
        protocolAddress: protocol.toLowerCase(),
        startBlock: row.start_block,
        indexedThrough: row.indexed_through,
        blockHash: row.block_hash,
      });
    };
    let checkpoint = await readCheckpoint();
    const topic = toEventSelector(getAbiItem({ abi: sweepAbi, name: "OrderFulfilled" }));
    for (let step = 0; step < steps; step++) {
      stage = "canonical finalized RPC scan";
      const result = await scanNativeHistoryRange(
        checkpoint,
        {
          finalized: () => client.getBlock({ blockTag: "finalized" }),
          block: (number) => client.getBlock({ blockNumber: number }),
          logs: async (fromBlock, toBlock) =>
            (await client.getLogs({ address: protocol, fromBlock, toBlock })).filter(
              (log) => log.topics[0]?.toLowerCase() === topic,
            ),
        },
        rangeSize,
      );
      stage = "atomic event publication";
      await connection.query("BEGIN");
      try {
        // Compare-and-swap protects even against a writer that does not share this session lock.
        const updated = await connection.query(
          `UPDATE public.marketplace_history_checkpoints SET indexed_through=$2, block_hash=$3, finalized_target=$8, updated_at=NOW() WHERE chain_id=8453 AND protocol_address=$1 AND indexed_through IS NOT DISTINCT FROM $4::numeric AND block_hash IS NOT DISTINCT FROM $5 AND start_block=$6 AND deployment_hash=$7 RETURNING protocol_address`,
          [
            protocol.toLowerCase(),
            result.checkpoint.indexedThrough,
            result.checkpoint.blockHash,
            checkpoint.indexedThrough,
            checkpoint.blockHash,
            checkpoint.startBlock,
            deploymentHash.toLowerCase(),
            result.finalizedTarget,
          ],
        );
        if (updated.rowCount !== 1) throw new Error("Concurrent checkpoint change");
        for (const event of result.events) {
          await connection.query(
            `INSERT INTO public.marketplace_history_events (chain_id,protocol_address,transaction_hash,log_index,block_number,block_hash,collection_address,token_id,event) VALUES (8453,$1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
            [
              event.protocolAddress,
              event.transactionHash,
              event.logIndex,
              event.blockNumber,
              event.blockHash,
              event.sale?.collectionAddress ?? null,
              event.sale?.tokenId ?? null,
              JSON.stringify(event),
            ],
          );
        }
        await connection.query("COMMIT");
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      }
      checkpoint = result.checkpoint;
      console.log(
        JSON.stringify({
          indexedThrough: checkpoint.indexedThrough,
          events: result.events.length,
          finalizedTarget: result.finalizedTarget,
          caughtUp: result.caughtUp,
        }),
      );
      if (result.caughtUp) break;
    }
  } finally {
    connection.release(true);
    await pool.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  syncNativeHistoryMain().catch(() => {
    console.error(
      `Native history synchronization failed at ${stage}. No incomplete range was committed; verify configuration and provider availability.`,
    );
    process.exitCode = 1;
  });
}
