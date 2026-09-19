import { z } from "zod";
import type { MarketplaceTrait } from "./nft-metadata";

const uint = z
  .string()
  .max(78)
  .regex(/^(0|[1-9]\d*)$/)
  .refine((v) => BigInt(v) < 2n ** 256n);
const traits = z
  .array(z.object({ type: z.string().min(1).max(80), value: z.string().max(200) }))
  .max(64);
export const traitIndexSchema = z
  .object({
    version: z.literal(1),
    chainId: z.literal(8453),
    collection: z.string().regex(/^0x[0-9a-f]{40}$/),
    blockNumber: uint,
    blockHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    expectedCount: z.number().int().nonnegative().max(100_000),
    cursor: uint.nullable(),
    enumerated: z.boolean(),
    entries: z.array(z.object({ tokenId: uint, traits: traits.nullable() })).max(100_000),
  })
  .strict();
export type TraitIndex = z.infer<typeof traitIndexSchema>;

export function validateTraitIndex(raw: unknown): TraitIndex {
  const index = traitIndexSchema.parse(raw);
  if (index.entries.length > index.expectedCount) throw new Error("Trait index exceeds supply");
  let previous: bigint | null = null;
  for (const entry of index.entries) {
    const id = BigInt(entry.tokenId);
    if (previous !== null && id >= previous)
      throw new Error("Trait IDs must be unique and descending");
    previous = id;
  }
  if (index.cursor !== (index.entries.at(-1)?.tokenId ?? null))
    throw new Error("Trait cursor mismatch");
  if (index.enumerated && index.entries.length !== index.expectedCount)
    throw new Error("Trait index supply mismatch");
  return index;
}

export function traitIndexComplete(index: TraitIndex) {
  validateTraitIndex(index);
  return index.enumerated && index.entries.every((entry) => entry.traits !== null);
}

/** One bounded step; persist its result before scheduling another step. */
export async function advanceTraitIndex(
  raw: unknown,
  io: {
    blockHash: () => Promise<string>;
    page: (before: string | null) => Promise<string[]>;
    read: (ids: string[]) => Promise<Array<MarketplaceTrait[] | null>>;
  },
  batchSize = 24,
): Promise<TraitIndex> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 48)
    throw new Error("Invalid trait batch size");
  const index = validateTraitIndex(structuredClone(raw));
  if ((await io.blockHash()).toLowerCase() !== index.blockHash)
    throw new Error("Trait index block changed");
  const missing = index.entries.filter((entry) => entry.traits === null).slice(0, batchSize);
  if (!missing.length && !index.enumerated) {
    const ids = await io.page(index.cursor);
    if (ids.length > batchSize) throw new Error("Trait page exceeds batch");
    if (!ids.length) index.enumerated = true;
    else {
      index.entries.push(...ids.map((tokenId) => ({ tokenId, traits: null })));
      index.cursor = ids.at(-1)!;
    }
    validateTraitIndex(index);
    missing.push(...index.entries.filter((entry) => entry.traits === null).slice(0, batchSize));
  }
  if (missing.length) {
    const values = await io.read(missing.map((entry) => entry.tokenId));
    if (values.length !== missing.length) throw new Error("Trait result count mismatch");
    values.forEach((value, i) => {
      missing[i].traits = value === null ? null : traits.parse(value);
    });
  }
  // Reorgs during the reads must never produce a publishable mixed-block index.
  if ((await io.blockHash()).toLowerCase() !== index.blockHash)
    throw new Error("Trait index block changed");
  return validateTraitIndex(index);
}

export function matchIndexedTraits(
  index: TraitIndex,
  selection: Record<string, string[]>,
): string[] {
  if (!traitIndexComplete(index)) throw new Error("Trait index is incomplete");
  const filters = Object.entries(selection).filter(([, values]) => values.length);
  return index.entries
    .filter((entry) =>
      filters.every(([type, values]) =>
        entry.traits!.some((trait) => trait.type === type && values.includes(trait.value)),
      ),
    )
    .map((entry) => entry.tokenId);
}
