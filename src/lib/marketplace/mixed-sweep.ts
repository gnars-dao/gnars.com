import { getAddress, isAddressEqual, type Address } from "viem";
import { z } from "zod";
import type { MarketplaceItem, MarketplaceOffer } from "@/types/marketplace";
import { getMarketplaceProtocolAddress } from "./routing";
import { getListingOrderHash, getListingPriceWei } from "./seaport";
import { MAX_SWEEP_ITEMS } from "./sweep";
import type { SweepQuote } from "./sweep";
import { validateSweepQuote } from "./sweep-journal";

const uint = z
  .string()
  .regex(/^(0|[1-9]\d{0,77})$/)
  .refine((v) => BigInt(v) < 2n ** 256n);
const address = z.string().transform((value, ctx) => {
  try {
    return getAddress(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid address" });
    return z.NEVER;
  }
});
export const mixedSweepSelectionSchema = z
  .object({
    source: z.enum(["gnars-contract", "opensea"]),
    tokenId: uint,
    orderHash: z
      .string()
      .regex(/^0x[\da-fA-F]{64}$/)
      .transform((v) => v as `0x${string}`),
    priceWei: uint.refine((v) => BigInt(v) > 0n),
  })
  .strict();
export type MixedSweepSelection = z.infer<typeof mixedSweepSelectionSchema>;
export type MixedSweepPlan = {
  buyer: Address;
  items: MarketplaceItem[];
  totalWei: string;
  expiresAt: number;
};

export function compareSweepOffers(a: MarketplaceOffer, b: MarketplaceOffer) {
  const left = BigInt(a.priceWei),
    right = BigInt(b.priceWei);
  if (left !== right) return left < right ? -1 : 1;
  if (a.source !== b.source) return a.source === "gnars-contract" ? -1 : 1;
  return a.orderHash.toLowerCase().localeCompare(b.orderHash.toLowerCase());
}

export function sweepSelection(item: MarketplaceItem): MixedSweepSelection {
  const offer = item.offers[0];
  return mixedSweepSelectionSchema.parse({
    source: offer.source,
    tokenId: item.tokenId,
    orderHash: offer.orderHash,
    priceWei: offer.priceWei,
  });
}

const offerSchema = mixedSweepSelectionSchema.omit({ tokenId: true }).extend({
  id: z.string().max(200),
  protocolAddress: address,
  seller: address,
  currency: z.literal("ETH"),
  expiresAt: z.number().int().positive().safe(),
});
const planSchema = z
  .object({
    buyer: address,
    items: z
      .array(
        z
          .object({
            tokenId: uint,
            name: z.string().max(500),
            image: z.string().max(10000).nullable(),
            owner: address.nullable(),
            offers: z.array(offerSchema).length(1),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_SWEEP_ITEMS),
    totalWei: uint,
    expiresAt: z.number().int().positive().safe(),
  })
  .strict();

/** Local storage and API previews are not authority to change recipients or prices. */
export function validateMixedSweepPlan(
  raw: unknown,
  buyer: Address,
  allowExpired = false,
): MixedSweepPlan {
  const plan = planSchema.parse(raw);
  if (
    !isAddressEqual(plan.buyer, buyer) ||
    new Set(plan.items.map((i) => i.tokenId)).size !== plan.items.length
  )
    throw new Error("Sweep identity changed");
  let total = 0n;
  for (const item of plan.items) {
    const offer = item.offers[0];
    if (
      !isAddressEqual(offer.protocolAddress, getMarketplaceProtocolAddress(offer.source)) ||
      isAddressEqual(offer.seller, buyer) ||
      !item.owner ||
      !isAddressEqual(item.owner, offer.seller) ||
      (!allowExpired && offer.expiresAt < plan.expiresAt)
    )
      throw new Error("Invalid sweep offer");
    total += BigInt(offer.priceWei);
  }
  if (
    total.toString() !== plan.totalWei ||
    (!allowExpired && plan.expiresAt <= Math.floor(Date.now() / 1000))
  )
    throw new Error("Sweep quote expired or changed");
  return plan;
}

export function bindNativeSweepQuote(plan: MixedSweepPlan, raw: SweepQuote, buyer: Address) {
  const quote = validateSweepQuote(raw, buyer);
  if (
    quote.totalWei !== plan.totalWei ||
    quote.listings.length !== plan.items.length ||
    plan.items.some((item, index) => {
      const listing = quote.listings[index];
      return (
        item.offers[0].source !== "gnars-contract" ||
        item.tokenId !== listing.parameters.offer[0].identifierOrCriteria ||
        item.offers[0].orderHash.toLowerCase() !==
          getListingOrderHash(listing.parameters).toLowerCase() ||
        item.offers[0].priceWei !== getListingPriceWei(listing).toString()
      );
    })
  )
    throw new Error("Native sweep changed from the reviewed plan");
  return quote;
}
