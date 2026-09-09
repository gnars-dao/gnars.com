import {
  encodeFunctionData,
  hashStruct,
  isAddressEqual,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { z } from "zod";
import { DAO_ADDRESSES } from "@/lib/config";
import {
  orderTypes,
  SEAPORT_ADDRESS,
  seaportAbi,
  validateListingStructure,
  type SignedListing,
} from "./seaport";

const address = z
  .string()
  .regex(/^0x[\da-fA-F]{40}$/)
  .transform((v) => v as Address);
const bytes32 = z
  .string()
  .regex(/^0x[\da-fA-F]{64}$/)
  .transform((v) => v as Hex);
const decimalUint = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .max(78)
  .refine((v) => BigInt(v) < 2n ** 256n);
const feeConfigSchema = z
  .object({
    recipient: address.refine((v) => !isAddressEqual(v, zeroAddress)),
    basisPoints: z.number().int().positive().max(9999),
  })
  .strict();
export type OpenSeaListingFee = z.infer<typeof feeConfigSchema>;
export type OpenSeaListingQuote = {
  priceWei: string;
  sellerWei: string;
  fees: Array<OpenSeaListingFee & { amountWei: string }>;
};

function percentageBasisPoints(value: string | number): number {
  // Decimal parsing avoids floating point multiplication changing a published fee.
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(String(value));
  if (!match || (match[2]?.slice(2).replace(/0/g, "") ?? "") !== "")
    throw new Error("OpenSea fee cannot be represented in basis points");
  const bps = BigInt(match[1]) * 100n + BigInt((match[2] ?? "").slice(0, 2).padEnd(2, "0"));
  if (bps >= 10000n) throw new Error("Invalid OpenSea fee percentage");
  return Number(bps);
}

export function parseOpenSeaListingFees(raw: unknown): OpenSeaListingFee[] {
  const collection = z
    .object({
      collection: z.literal("gnars-dao"),
      contracts: z
        .array(z.object({ address, chain: z.string() }))
        .min(1)
        .max(20),
      required_zone: address.nullish(),
      fees: z
        .array(
          z.object({
            fee: z.union([z.number().finite(), z.string().max(100)]),
            recipient: address,
            required: z.boolean(),
          }),
        )
        .max(20),
    })
    .parse(raw);
  if (
    !collection.contracts.some(
      (c) => c.chain === "base" && isAddressEqual(c.address, DAO_ADDRESSES.token),
    )
  )
    throw new Error("OpenSea collection does not match Gnars on Base");
  if (collection.required_zone && !isAddressEqual(collection.required_zone, zeroAddress))
    throw new Error("OpenSea requires an unsupported listing zone");
  const fees = collection.fees
    .filter((fee) => fee.required)
    .flatMap((fee) => {
      const basisPoints = percentageBasisPoints(fee.fee);
      return basisPoints === 0 ? [] : [{ recipient: fee.recipient, basisPoints }];
    });
  return validateFeeConfigs(fees);
}

function validateFeeConfigs(raw: unknown): OpenSeaListingFee[] {
  const fees = z.array(feeConfigSchema).max(9).parse(raw);
  if (fees.reduce((sum, fee) => sum + fee.basisPoints, 0) >= 10000)
    throw new Error("OpenSea fees consume the entire price");
  return fees;
}

export function buildOpenSeaListingQuote(
  priceWei: string,
  feeConfigs: readonly OpenSeaListingFee[],
): OpenSeaListingQuote {
  const price = BigInt(decimalUint.parse(priceWei));
  if (price <= 0n) throw new Error("Listing price must be positive");
  const fees = validateFeeConfigs(feeConfigs).map((fee) => {
    const amount = (price * BigInt(fee.basisPoints)) / 10000n;
    if (amount === 0n) throw new Error("Listing price is too small for the required OpenSea fee");
    return { ...fee, amountWei: amount.toString() };
  });
  const seller = price - fees.reduce((sum, fee) => sum + BigInt(fee.amountWei), 0n);
  if (seller <= 0n) throw new Error("Seller proceeds must be positive");
  return { priceWei, sellerWei: seller.toString(), fees };
}

export function validateOpenSeaListingFees(
  listing: SignedListing,
  quote: OpenSeaListingQuote,
): void {
  const valid = validateListingStructure(listing, { source: "opensea" });
  const calculated = buildOpenSeaListingQuote(
    quote.priceWei,
    quote.fees.map(({ recipient, basisPoints }) => ({ recipient, basisPoints })),
  );
  if (
    quote.sellerWei !== calculated.sellerWei ||
    quote.fees.some((fee, index) => fee.amountWei !== calculated.fees[index].amountWei)
  )
    throw new Error("Invalid OpenSea fee quote");
  const expected = [
    { recipient: valid.parameters.offerer, amountWei: calculated.sellerWei },
    ...calculated.fees,
  ];
  if (
    valid.parameters.consideration.length !== expected.length ||
    expected.some((fee, index) => {
      const actual = valid.parameters.consideration[index];
      return (
        !isAddressEqual(actual.recipient, fee.recipient) || actual.startAmount !== fee.amountWei
      );
    })
  )
    throw new Error("Listing does not match the OpenSea fee quote");
}

const apiUint = z
  .union([
    decimalUint,
    z.string().regex(/^0x[\da-fA-F]{1,64}$/),
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    z
      .bigint()
      .nonnegative()
      .max(2n ** 256n - 1n),
  ])
  .transform((v) => BigInt(v));
const apiItem = z.object({
  itemType: z.number().int(),
  token: address,
  identifierOrCriteria: apiUint,
  startAmount: apiUint,
  endAmount: apiUint,
});
const apiOrder = z.object({
  chain: z.literal("base"),
  order_hash: bytes32,
  protocol_address: address,
  protocol_data: z.object({
    parameters: z.object({
      offerer: address,
      zone: address,
      offer: z.array(apiItem).length(1),
      consideration: z
        .array(apiItem.extend({ recipient: address }))
        .min(1)
        .max(10),
      orderType: z.number().int().min(0).max(3),
      startTime: apiUint,
      endTime: apiUint,
      zoneHash: bytes32,
      salt: apiUint,
      conduitKey: bytes32,
      counter: apiUint,
    }),
  }),
});

export function getOpenSeaCancellation(
  rawOrder: unknown,
  expected: { orderHash: Hex; seller: Address; tokenId: string },
): { to: Address; data: Hex; value: bigint } {
  const order = z
    .union([apiOrder, z.object({ order: apiOrder }).transform((v) => v.order)])
    .parse(rawOrder);
  const p = order.protocol_data.parameters;
  const nft = p.offer[0];
  if (
    !isAddressEqual(order.protocol_address, SEAPORT_ADDRESS) ||
    !isAddressEqual(p.offerer, expected.seller) ||
    isAddressEqual(p.offerer, zeroAddress) ||
    nft.itemType !== 2 ||
    !isAddressEqual(nft.token, DAO_ADDRESSES.token) ||
    nft.identifierOrCriteria !== BigInt(decimalUint.parse(expected.tokenId)) ||
    nft.startAmount !== 1n ||
    nft.endAmount !== 1n ||
    p.endTime <= p.startTime ||
    p.consideration.some(
      (item) =>
        item.itemType !== 0 ||
        !isAddressEqual(item.token, zeroAddress) ||
        item.identifierOrCriteria !== 0n ||
        item.startAmount <= 0n ||
        item.startAmount !== item.endAmount ||
        isAddressEqual(item.recipient, zeroAddress),
    )
  )
    throw new Error("Unsupported OpenSea cancellation");
  const hash = hashStruct({ data: p, primaryType: "OrderComponents", types: orderTypes });
  if (
    hash.toLowerCase() !== expected.orderHash.toLowerCase() ||
    hash.toLowerCase() !== order.order_hash.toLowerCase()
  )
    throw new Error("OpenSea cancellation order hash mismatch");
  // Cancellation needs exact components, not a signature or fulfillment routing permission.
  return {
    to: SEAPORT_ADDRESS,
    data: encodeFunctionData({ abi: seaportAbi, functionName: "cancel", args: [[p]] }),
    value: 0n,
  };
}
