import { isAddress } from "viem";
import { z } from "zod";

const address = z.string().refine((value) => isAddress(value, { strict: false }));
const uint = z
  .string()
  .max(78)
  .regex(/^(0|[1-9]\d*)$/);
const identity = { collectionAddress: address, tokenId: uint };
export const marketplaceTraitsSchema = z.object({
  ...identity,
  source: z.literal("tokenURI"),
  traits: z.array(z.object({ type: z.string().max(80), value: z.string().max(200) })).max(64),
});
export const marketplaceActivitySchema = z.object({
  ...identity,
  source: z.enum(["opensea", "combined"]),
  sources: z
    .object({
      opensea: z.object({ available: z.boolean() }),
      gnars: z.object({ available: z.boolean() }),
    })
    .optional(),
  coverage: z
    .object({
      startBlock: uint,
      indexedThrough: uint,
      blockHash: z.string().regex(/^0x[\da-fA-F]{64}$/),
    })
    .optional(),
  nextCursor: z.string().max(8192).nullable(),
  events: z
    .array(
      z.object({
        id: z.string().max(512),
        type: z.enum(["sale", "transfer", "mint", "burn"]),
        source: z.enum(["gnars-contract", "opensea"]).optional(),
        transactionHash: z.string().regex(/^0x[\da-fA-F]{64}$/),
        timestamp: z.number().int().positive().max(8640000000000),
        from: address.nullable(),
        to: address.nullable(),
        payment: z
          .object({
            quantity: uint,
            decimals: z.number().int().min(0).max(36),
            symbol: z.string().max(32),
            tokenAddress: address,
          })
          .optional(),
      }),
    )
    .max(200),
});
export type MarketplaceActivityEvent = z.infer<typeof marketplaceActivitySchema>["events"][number];

export function isNftInsightIdentity(
  result: { collectionAddress: string; tokenId: string },
  collection: string,
  tokenId: string,
) {
  return (
    result.collectionAddress.toLowerCase() === collection.toLowerCase() &&
    BigInt(result.tokenId) === BigInt(tokenId)
  );
}

/** One sale and its NFT transfer may be delivered on different provider pages. */
export function mergeNftActivity(events: MarketplaceActivityEvent[]) {
  const unique = [...new Map(events.map((event) => [event.id, event])).values()];
  const movement = (event: MarketplaceActivityEvent) =>
    [event.transactionHash, event.from ?? "", event.to ?? ""].join(":").toLowerCase();
  const sales = new Set(unique.filter((event) => event.type === "sale").map(movement));
  // Native log IDs distinguish multiple fills; only remove overlapping provider summaries.
  const nativeSales = new Set(
    unique
      .filter((event) => event.type === "sale" && event.source === "gnars-contract")
      .map(movement),
  );
  return unique
    .filter(
      (event) =>
        event.type !== "sale" ||
        event.source === "gnars-contract" ||
        !nativeSales.has(movement(event)),
    )
    .filter((event) => event.type !== "transfer" || !sales.has(movement(event)))
    .sort((a, b) => b.timestamp - a.timestamp);
}
