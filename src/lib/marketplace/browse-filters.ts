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
  traits: z.string().min(1).max(4096).optional(),
  traitSnapshot: z
    .string()
    .regex(/^0x[0-9a-f]{64}$/)
    .optional(),
};

const schema = z
  .object(marketplaceBrowseFilterShape)
  .strict()
  .refine(({ traits, traitSnapshot }) => !!traits === !!traitSnapshot, {
    message: "Trait snapshot required",
  })
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
  const result = schema.parse(input);
  if (result.traits) result.traits = JSON.stringify(parseTraitSelection(result.traits));
  return result;
}

export function parseTraitSelection(raw: string): Record<string, string[]> {
  const selection = z
    .record(z.string().min(1).max(80), z.array(z.string().max(200)).min(1).max(32))
    .parse(JSON.parse(raw));
  const entries = Object.entries(selection);
  if (!entries.length || entries.length > 5 || raw.length > 4096)
    throw new Error("Invalid trait selection");
  return Object.fromEntries(
    entries
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, values]) => [key, [...new Set(values)].sort()]),
  );
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
