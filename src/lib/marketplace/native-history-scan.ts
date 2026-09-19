import { z } from "zod";
import { parseNativeHistoryLog, type NativeHistoryEvent } from "./native-history";

const uint = z
  .string()
  .max(78)
  .regex(/^(0|[1-9]\d*)$/)
  .refine((v) => BigInt(v) < 2n ** 256n);
const hash = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/)
  .refine((v) => !/^0x0+$/.test(v));
export const nativeHistoryCheckpointSchema = z
  .object({
    version: z.literal(1),
    chainId: z.literal(8453),
    protocolAddress: z
      .string()
      .regex(/^0x[0-9a-f]{40}$/)
      .refine((v) => !/^0x0+$/.test(v)),
    startBlock: uint,
    indexedThrough: uint.nullable(),
    blockHash: hash.nullable(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      (v.indexedThrough === null) !== (v.blockHash === null) ||
      (v.indexedThrough !== null && BigInt(v.indexedThrough) < BigInt(v.startBlock))
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid history checkpoint" });
  });
export type NativeHistoryCheckpoint = z.infer<typeof nativeHistoryCheckpointSchema>;
type HistoryLog = Parameters<typeof parseNativeHistoryLog>[0];
type Block = { number: bigint; hash: string; timestamp: bigint };

/** The caller must atomically persist events and checkpoint, never either independently. */
export async function scanNativeHistoryRange(
  raw: unknown,
  io: {
    finalized: () => Promise<Block>;
    block: (number: bigint) => Promise<Block>;
    logs: (from: bigint, to: bigint) => Promise<HistoryLog[]>;
  },
  rangeSize = 2000,
): Promise<{
  checkpoint: NativeHistoryCheckpoint;
  events: NativeHistoryEvent[];
  finalizedTarget: string;
  caughtUp: boolean;
}> {
  const checkpoint = nativeHistoryCheckpointSchema.parse(raw);
  if (!Number.isSafeInteger(rangeSize) || rangeSize < 1 || rangeSize > 10000)
    throw new Error("Invalid history scan range");
  const validateBlock = (block: Block, expected?: bigint) => {
    if (
      block.number < 0n ||
      (expected !== undefined && block.number !== expected) ||
      !hash.safeParse(block.hash).success ||
      block.timestamp <= 0n ||
      block.timestamp > 8640000000000n
    )
      throw new Error("Invalid history block");
    return block;
  };
  const target = validateBlock(await io.finalized());
  if (checkpoint.indexedThrough !== null) {
    const number = BigInt(checkpoint.indexedThrough);
    if (
      number > target.number ||
      validateBlock(await io.block(number), number).hash !== checkpoint.blockHash
    )
      throw new Error("History checkpoint is not canonical and finalized");
  }
  const from =
    checkpoint.indexedThrough === null
      ? BigInt(checkpoint.startBlock)
      : BigInt(checkpoint.indexedThrough) + 1n;
  if (from > target.number)
    return { checkpoint, events: [], finalizedTarget: String(target.number), caughtUp: true };
  const last = from + BigInt(rangeSize) - 1n;
  const to = last < target.number ? last : target.number;
  const anchor = validateBlock(await io.block(to), to);
  if (to === target.number && anchor.hash !== target.hash)
    throw new Error("History target changed");
  const logs = await io.logs(from, to);
  if (logs.length > 10000) throw new Error("History log range too large");
  const blocks = new Map<bigint, Block>([[to, anchor]]);
  const positions = new Set<string>();
  const events: NativeHistoryEvent[] = [];
  for (const log of logs) {
    if (typeof log.blockNumber !== "bigint" || log.blockNumber < from || log.blockNumber > to)
      throw new Error("History log outside requested range");
    const position = `${log.blockNumber}:${log.logIndex}`;
    if (positions.has(position)) throw new Error("Duplicate history log position");
    positions.add(position);
    let block = blocks.get(log.blockNumber);
    if (!block) {
      block = validateBlock(await io.block(log.blockNumber), log.blockNumber);
      blocks.set(log.blockNumber, block);
    }
    events.push(
      parseNativeHistoryLog(log, {
        chainId: checkpoint.chainId,
        protocolAddress: checkpoint.protocolAddress,
        blockNumber: block.number,
        blockHash: block.hash,
        timestamp: Number(block.timestamp),
      }),
    );
  }
  // Even an empty range requires a stable chain anchor before advancing coverage.
  if (validateBlock(await io.block(to), to).hash !== anchor.hash)
    throw new Error("History range changed during scan");
  if (
    checkpoint.indexedThrough !== null &&
    validateBlock(
      await io.block(BigInt(checkpoint.indexedThrough)),
      BigInt(checkpoint.indexedThrough),
    ).hash !== checkpoint.blockHash
  )
    throw new Error("History checkpoint changed during scan");
  return {
    checkpoint: { ...checkpoint, indexedThrough: String(to), blockHash: anchor.hash },
    events,
    finalizedTarget: String(target.number),
    caughtUp: to === target.number,
  };
}
