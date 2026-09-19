import "server-only";
import { unstable_cache } from "next/cache";
import { zeroAddress } from "viem";
import { z } from "zod";
import { RequestSecurityError } from "@/lib/server/request-security";
import {
  MARKETPLACE_CACHE_TAG,
  marketplaceAddressSchema,
  marketplaceHashSchema,
  marketplaceUintSchema,
  marketplaceUnavailable,
  parseMarketplaceInput,
} from "@/services/marketplace-common";
import { requestOpenSeaNftActivity } from "@/services/marketplace-opensea";

const address = marketplaceAddressSchema.transform((value) => value.toLowerCase());
const collectionAddress = address.refine((value) => value !== zeroAddress);
const providerCursor = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[\x21-\x7e]+$/);
export const marketplaceActivityQuerySchema = z
  .object({
    collection: collectionAddress,
    tokenId: marketplaceUintSchema,
    cursor: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict();
const cursorSchema = z
  .object({
    version: z.literal(1),
    collection: collectionAddress,
    tokenId: marketplaceUintSchema,
    next: providerCursor,
  })
  .strict();
const paymentSchema = z
  .object({
    quantity: marketplaceUintSchema,
    decimals: z.number().int().min(0).max(36),
    symbol: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[^\x00-\x1f\x7f]+$/),
    token_address: address,
  })
  .superRefine((payment, ctx) => {
    const symbol = payment.symbol.trim().toUpperCase();
    if (
      (symbol === "ETH" && (payment.token_address !== zeroAddress || payment.decimals !== 18)) ||
      (symbol === "WETH" &&
        (payment.token_address !== "0x4200000000000000000000000000000000000006" ||
          payment.decimals !== 18))
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Payment token identity mismatch" });
  });
const baseEventSchema = z.object({
  event_type: z.enum(["sale", "transfer"]),
  event_timestamp: z.number().int().positive().max(8_640_000_000_000),
  transaction: marketplaceHashSchema.transform((value) => value.toLowerCase()),
  chain: z.literal("base"),
  quantity: z.union([z.literal(1), z.literal("1")]),
  nft: z.object({
    identifier: marketplaceUintSchema,
    contract: collectionAddress,
    token_standard: z.literal("erc721"),
  }),
  order_hash: marketplaceHashSchema.optional(),
  protocol_address: address.optional(),
});
const saleSchema = baseEventSchema.extend({
  event_type: z.literal("sale"),
  seller: collectionAddress,
  buyer: collectionAddress,
  payment: paymentSchema.optional(),
});
const transferSchema = baseEventSchema.extend({
  event_type: z.literal("transfer"),
  transfer_type: z.enum(["transfer", "mint", "burn"]),
  from_address: address,
  to_address: address,
});

export type MarketplaceActivityEvent = {
  id: string;
  type: "sale" | "transfer" | "mint" | "burn";
  transactionHash: string;
  timestamp: number;
  from: string | null;
  to: string | null;
  payment?: { quantity: string; decimals: number; symbol: string; tokenAddress: string };
};
export type MarketplaceActivityPage = {
  collectionAddress: string;
  tokenId: string;
  events: MarketplaceActivityEvent[];
  nextCursor: string | null;
  source: "opensea";
};

function decodeCursor(raw: string | undefined, collection: string, tokenId: string) {
  if (!raw) return undefined;
  try {
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    if (cursor.collection !== collection || cursor.tokenId !== tokenId)
      throw new Error("Scope mismatch");
    return cursor.next;
  } catch {
    throw new RequestSecurityError(400, "Invalid NFT activity cursor.");
  }
}

async function loadActivity(
  collection: string,
  tokenId: string,
  next?: string,
): Promise<MarketplaceActivityPage> {
  const raw = await requestOpenSeaNftActivity(collection, tokenId, next);
  const envelope = z
    .object({
      asset_events: z.array(z.unknown()).max(20),
      next: providerCursor.nullish(),
    })
    .safeParse(raw);
  if (!envelope.success || (next && envelope.data?.next === next))
    throw marketplaceUnavailable("NFT activity could not be verified.");
  const events = new Map<string, MarketplaceActivityEvent>();
  for (const rawEvent of envelope.data.asset_events) {
    const kind = z.object({ event_type: z.string() }).safeParse(rawEvent);
    if (!kind.success) throw marketplaceUnavailable("NFT activity could not be verified.");
    if (kind.data.event_type !== "sale" && kind.data.event_type !== "transfer") continue;
    const parsed = z
      .discriminatedUnion("event_type", [saleSchema, transferSchema])
      .safeParse(rawEvent);
    if (!parsed.success) throw marketplaceUnavailable("NFT activity could not be verified.");
    const event = parsed.data;
    if (event.nft.contract !== collection || event.nft.identifier !== tokenId)
      throw marketplaceUnavailable("NFT activity identity could not be verified.");
    let type: MarketplaceActivityEvent["type"] = event.event_type;
    const from = event.event_type === "sale" ? event.seller : event.from_address;
    const to = event.event_type === "sale" ? event.buyer : event.to_address;
    if (event.event_type === "transfer") {
      type = from === zeroAddress ? "mint" : to === zeroAddress ? "burn" : "transfer";
      if (
        (from === zeroAddress && to === zeroAddress) ||
        (event.transfer_type !== "transfer" && event.transfer_type !== type)
      )
        throw marketplaceUnavailable("NFT activity transfer could not be verified.");
    }
    const id = `${event.transaction}:${type}:${from}:${to}`;
    const payment = event.event_type === "sale" ? event.payment : undefined;
    events.set(id, {
      id,
      type,
      transactionHash: event.transaction,
      timestamp: event.event_timestamp,
      from: from === zeroAddress ? null : from,
      to: to === zeroAddress ? null : to,
      ...(payment
        ? {
            payment: {
              quantity: payment.quantity,
              decimals: payment.decimals,
              symbol: payment.symbol,
              tokenAddress: payment.token_address,
            },
          }
        : {}),
    });
  }
  return {
    collectionAddress: collection,
    tokenId,
    events: [...events.values()].sort((a, b) => b.timestamp - a.timestamp),
    nextCursor: envelope.data.next
      ? Buffer.from(
          JSON.stringify({ version: 1, collection, tokenId, next: envelope.data.next }),
        ).toString("base64url")
      : null,
    source: "opensea",
  };
}
const cachedActivity = unstable_cache(loadActivity, ["marketplace-activity-v1"], {
  revalidate: 30,
  tags: [MARKETPLACE_CACHE_TAG],
});

export async function getMarketplaceActivity(raw: unknown): Promise<MarketplaceActivityPage> {
  const input = parseMarketplaceInput(marketplaceActivityQuerySchema, raw);
  return cachedActivity(
    input.collection,
    input.tokenId,
    decodeCursor(input.cursor, input.collection, input.tokenId),
  );
}
