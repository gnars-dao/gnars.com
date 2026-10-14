/**
 * Locating `BountyCreated` logs without scanning the whole chain.
 *
 * Public Base RPCs cap `eth_getLogs` at 10k blocks, and a full scan from the deploy
 * block grows by ~4 chunks a day forever. But every bounty row already carries its
 * `createdAt`, and Base produces a block every 2 seconds, so the creation block can be
 * estimated and only the chunks that can contain it are fetched. Chunks are aligned
 * to the deploy block so the same chunk is requested (and cached) every time.
 */

export const BASE_BLOCK_TIME_SECONDS = 2;
export const LOG_CHUNK_BLOCKS = 10_000n;
/** Slack around an estimated block (blocks), covering clock skew and estimate drift. */
export const ESTIMATE_MARGIN_BLOCKS = 900n;

export interface BlockRef {
  number: bigint;
  timestamp: number;
}

export function estimateBlockAt(
  timestamp: number,
  ref: BlockRef,
  blockTime = BASE_BLOCK_TIME_SECONDS,
) {
  const deltaBlocks = BigInt(Math.floor((ref.timestamp - timestamp) / blockTime));
  const est = ref.number - deltaBlocks;
  return est < 0n ? 0n : est;
}

export interface BlockRange {
  fromBlock: bigint;
  toBlock: bigint;
}

/**
 * Deploy-aligned chunk ranges that cover every timestamp's estimated block ± margin,
 * clamped to [deployBlock, latest]. Sorted, de-duplicated.
 */
export function chunkRangesForTimestamps(
  timestamps: number[],
  opts: {
    deployBlock: bigint;
    latest: BlockRef;
    chunk?: bigint;
    margin?: bigint;
    blockTime?: number;
  },
): BlockRange[] {
  const chunk = opts.chunk ?? LOG_CHUNK_BLOCKS;
  const margin = opts.margin ?? ESTIMATE_MARGIN_BLOCKS;
  const { deployBlock, latest } = opts;
  if (latest.number < deployBlock) return [];

  const starts = new Set<bigint>();
  const chunkStart = (block: bigint) => {
    const clamped =
      block < deployBlock ? deployBlock : block > latest.number ? latest.number : block;
    return deployBlock + ((clamped - deployBlock) / chunk) * chunk;
  };

  for (const ts of timestamps) {
    const est = estimateBlockAt(ts, latest, opts.blockTime);
    const lo = chunkStart(est - margin);
    const hi = chunkStart(est + margin);
    for (let s = lo; s <= hi; s += chunk) starts.add(s);
  }

  return [...starts]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((fromBlock) => {
      const end = fromBlock + chunk - 1n;
      return { fromBlock, toBlock: end > latest.number ? latest.number : end };
    });
}
