/** Read-only custom Seaport history backfill. No signatures, transactions, or DB writes. */
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createPublicClient, getAbiItem, http, toEventSelector, type Hex } from "viem";
import { base } from "viem/chains";
import { type NativeHistoryEvent } from "../src/lib/marketplace/native-history";
import {
  nativeHistoryCheckpointSchema,
  scanNativeHistoryRange,
} from "../src/lib/marketplace/native-history-scan";
import { getGnarsMarketplaceAddress } from "../src/lib/marketplace/routing";
import { sweepAbi } from "../src/lib/marketplace/sweep";

let stage = "configuration";
async function main() {
  const [path, deploymentHash, stepsRaw = "1", rangeRaw = "2000"] = process.argv.slice(2);
  const steps = Number(stepsRaw);
  const rangeSize = Number(rangeRaw);
  if (
    !path ||
    !/^0x[\da-fA-F]{64}$/.test(deploymentHash ?? "") ||
    !Number.isInteger(steps) ||
    steps < 1 ||
    steps > 1000 ||
    !Number.isInteger(rangeSize) ||
    rangeSize < 1 ||
    rangeSize > 10000
  )
    throw new Error(
      "Usage: marketplace-history-index.ts <checkpoint.json> <deployment-tx> [steps:1..1000] [blocks:1..10000]",
    );
  const protocol = getGnarsMarketplaceAddress();
  if (!protocol) throw new Error("Gnars marketplace address is not configured");
  const rpc =
    process.env.BASE_RPC ||
    process.env.NEXT_PUBLIC_BASE_RPC_URL ||
    (process.env.ALCHEMY_API_KEY
      ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
      : undefined);
  if (!rpc) throw new Error("Base RPC configuration required");
  const client = createPublicClient({
    chain: base,
    transport: http(rpc, { timeout: 15000, retryCount: 0 }),
  });
  stage = "chain identity";
  if ((await client.getChainId()) !== 8453) throw new Error("Expected Base chain");
  stage = "deployment receipt";
  const deployment = await client.getTransactionReceipt({ hash: deploymentHash as Hex });
  if (
    deployment.status !== "success" ||
    deployment.contractAddress?.toLowerCase() !== protocol.toLowerCase()
  )
    throw new Error("Deployment does not create the configured marketplace");
  stage = "deployment finality";
  const canonical = await client.getBlock({ blockNumber: deployment.blockNumber });
  const finalized = await client.getBlock({ blockTag: "finalized" });
  if (canonical.hash !== deployment.blockHash || canonical.number > finalized.number)
    throw new Error("Deployment is not canonical and finalized");
  stage = "checkpoint lock";
  const lock = await open(`${path}.lock`, "wx", 0o600);
  try {
    let checkpoint = nativeHistoryCheckpointSchema.parse({
      version: 1,
      chainId: 8453,
      protocolAddress: protocol.toLowerCase(),
      startBlock: String(deployment.blockNumber),
      indexedThrough: null,
      blockHash: null,
    });
    let events: NativeHistoryEvent[] = [];
    stage = "checkpoint validation";
    try {
      const saved = JSON.parse(await readFile(path, "utf8"));
      const loaded = nativeHistoryCheckpointSchema.parse(saved.checkpoint);
      if (
        loaded.protocolAddress !== checkpoint.protocolAddress ||
        loaded.startBlock !== checkpoint.startBlock ||
        saved.deploymentHash !== deploymentHash.toLowerCase() ||
        !Array.isArray(saved.events)
      )
        throw new Error("History checkpoint identity mismatch");
      // Saved events are local output only; publication must independently validate them.
      const ids = new Set<string>();
      for (const event of saved.events) {
        if (
          !event ||
          typeof event.id !== "string" ||
          ids.has(event.id) ||
          event.chainId !== loaded.chainId ||
          event.protocolAddress !== loaded.protocolAddress ||
          typeof event.blockNumber !== "string" ||
          !/^(0|[1-9]\d*)$/.test(event.blockNumber) ||
          loaded.indexedThrough === null ||
          BigInt(event.blockNumber) < BigInt(loaded.startBlock) ||
          BigInt(event.blockNumber) > BigInt(loaded.indexedThrough)
        )
          throw new Error("Invalid saved history event");
        ids.add(event.id);
      }
      checkpoint = loaded;
      events = saved.events;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (let step = 0; step < steps; step++) {
      stage = "finalized range validation";
      const result = await scanNativeHistoryRange(
        checkpoint,
        {
          finalized: () => client.getBlock({ blockTag: "finalized" }),
          block: (number) => client.getBlock({ blockNumber: number }),
          logs: async (fromBlock, toBlock) => {
            stage = "RPC log range";
            const logs = await client.getLogs({
              address: protocol,
              fromBlock,
              toBlock,
            });
            const topic = toEventSelector(getAbiItem({ abi: sweepAbi, name: "OrderFulfilled" }));
            stage = "event and range validation";
            // Decode ourselves: malformed matching events must fail, never disappear silently.
            return logs.filter((log) => log.topics[0]?.toLowerCase() === topic);
          },
        },
        rangeSize,
      );
      const nextEvents = [...events, ...result.events];
      if (new Set(nextEvents.map((event) => event.id)).size !== nextEvents.length)
        throw new Error("Duplicate saved history event");
      stage = "checkpoint save";
      await writeFile(
        `${path}.tmp`,
        JSON.stringify({
          deploymentHash: deploymentHash.toLowerCase(),
          checkpoint: result.checkpoint,
          finalizedTarget: result.finalizedTarget,
          events: nextEvents,
        }),
        { mode: 0o600 },
      );
      await rename(`${path}.tmp`, path);
      checkpoint = result.checkpoint;
      events = nextEvents;
      console.log(
        `Indexed through ${checkpoint.indexedThrough}; ${events.length} fulfillments; finalized target ${result.finalizedTarget}`,
      );
      if (result.caughtUp) break;
    }
  } finally {
    await lock.close();
    await unlink(`${path}.lock`);
  }
}

main().catch(() => {
  console.error(
    `History indexing failed at ${stage}; no incomplete range was saved. Check RPC, deployment and checkpoint configuration.`,
  );
  process.exitCode = 1;
});
