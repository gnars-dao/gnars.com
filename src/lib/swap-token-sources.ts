import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import { z } from "zod";

export const SWAP_TOKEN_SOURCES_BATCH_SIZE = 25;
const addressSchema = z
  .string()
  .refine((value) => isAddress(value) && value.toLowerCase() !== zeroAddress)
  .transform((value) => getAddress(value));
export const swapTokenSourcesSchema = z.object({
  tokens: z
    .array(z.object({ address: addressSchema, source: z.enum(["zora", "clanker"]) }))
    .max(SWAP_TOKEN_SOURCES_BATCH_SIZE),
  complete: z.boolean(),
});
export type SwapTokenSources = z.infer<typeof swapTokenSourcesSchema>;
export type SwapTokenSource = SwapTokenSources["tokens"][number];

// Official Base v0/v1/v2 factories; legacy API rows can use type "proxy".
// https://github.com/clanker-devco/DOCS/blob/main/references/deployed-contracts.md
const legacyClankerFactories = new Set([
  "0x250c9fb2b411b48273f69879007803790a6aea47",
  "0x9b84fce5dcd9a38d2d01d5d72373f6b6b067c3e1",
  "0x732560fa1d1a76350b1a500155ba978031b53833",
]);

export function parseTokenSourceAddresses(params: URLSearchParams): Address[] {
  if (
    params.get("chainId") !== "8453" ||
    params.getAll("chainId").length !== 1 ||
    params.getAll("addresses").length !== 1 ||
    [...params.keys()].some((key) => key !== "chainId" && key !== "addresses")
  ) {
    throw new Error("Invalid token source query");
  }
  const addresses = z
    .array(addressSchema)
    .min(1)
    .max(SWAP_TOKEN_SOURCES_BATCH_SIZE)
    .parse(params.get("addresses")!.split(","));
  return [...new Set(addresses.map((address) => address.toLowerCase() as Address))].sort();
}

export function parseZoraTokenSources(
  raw: unknown,
  requested: readonly Address[],
): SwapTokenSource[] {
  const response = z
    .object({
      zora20Tokens: z
        .array(z.object({ address: addressSchema, chainId: z.number().int() }).nullable())
        .max(SWAP_TOKEN_SOURCES_BATCH_SIZE),
    })
    .parse(raw);
  const requestedKeys = new Set(requested.map((address) => address.toLowerCase()));
  const seen = new Set<string>();
  return (
    response.zora20Tokens
      // The live API returns null for non-Zora contracts despite the SDK's non-null type.
      .filter((token) => token !== null)
      .filter((token) => {
        const key = token.address.toLowerCase();
        if (token.chainId !== 8453 || !requestedKeys.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(({ address }) => ({ address, source: "zora" }))
  );
}

export function parseClankerTokenSource(raw: unknown, requested: Address): SwapTokenSource | null {
  const response = z
    .object({
      data: z
        .array(
          z.object({
            contract_address: addressSchema,
            chain_id: z.number().int(),
            factory_address: addressSchema,
            type: z.string(),
          }),
        )
        .max(20),
    })
    .parse(raw);
  const token = response.data.find(
    (token) =>
      token.contract_address.toLowerCase() === requested.toLowerCase() &&
      token.chain_id === 8453 &&
      (["clanker_v3", "clanker_v3.1", "clanker_v4"].includes(token.type) ||
        legacyClankerFactories.has(token.factory_address.toLowerCase())),
  );
  return token ? { address: token.contract_address, source: "clanker" } : null;
}
