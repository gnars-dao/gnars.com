import { parseEther } from "viem";
import { z } from "zod";

const uint256 = z
  .string()
  .max(78)
  .regex(/^(0|[1-9]\d*)$/)
  .refine(
    (value) => /^(0|[1-9]\d*)$/.test(value) && value.length <= 78 && BigInt(value) < 2n ** 256n,
  );

export const marketplaceBrowseFilterShape = {
  sort: z.literal("price-asc").optional(),
  minPriceWei: uint256.optional(),
  maxPriceWei: uint256.optional(),
};

const schema = z
  .object(marketplaceBrowseFilterShape)
  .strict()
  .refine(
    ({ minPriceWei, maxPriceWei }) =>
      minPriceWei === undefined ||
      maxPriceWei === undefined ||
      !/^(0|[1-9]\d*)$/.test(minPriceWei) ||
      !/^(0|[1-9]\d*)$/.test(maxPriceWei) ||
      minPriceWei.length > 78 ||
      maxPriceWei.length > 78 ||
      BigInt(minPriceWei) <= BigInt(maxPriceWei),
    { message: "Minimum price exceeds maximum price", path: ["maxPriceWei"] },
  );

export type MarketplaceBrowseFilters = z.infer<typeof schema>;

export function parseMarketplaceBrowseFilters(input: unknown): MarketplaceBrowseFilters {
  return schema.parse(input);
}

export function parseMarketplacePriceRange(min: string, max: string): MarketplaceBrowseFilters {
  function amount(input: string): string | undefined {
    const value = input.trim().replace(",", ".");
    if (!value) return undefined;
    // Validate precision before parseEther, which otherwise rounds extra decimals.
    if (!/^\d+(?:\.\d{1,18})?$/.test(value) || value.length > 100)
      throw new Error("Invalid ETH price");
    return parseEther(value).toString();
  }
  return parseMarketplaceBrowseFilters({
    sort: "price-asc",
    minPriceWei: amount(min),
    maxPriceWei: amount(max),
  });
}
