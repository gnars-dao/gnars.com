import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import { z } from "zod";
import { ipfsToHttp } from "@/lib/ipfs";

export type SwapDirectoryToken = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  logo?: string;
  category: "creator" | "stock";
  source: "zora" | "clanker" | "ondo" | "xstocks" | "coinbase";
  sourceUrl?: string;
};
export type SwapTokenDirectory = {
  tokens: SwapDirectoryToken[];
  sources: Record<"zora" | "clanker" | "stocks", { available: boolean }>;
};

const address = z
  .string()
  .refine((value) => isAddress(value) && value.toLowerCase() !== zeroAddress)
  .transform((value) => getAddress(value));
const label = z.string().trim().min(1).max(512);
const providerLabel = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .transform((value) => value.slice(0, 512).replace(/[\uD800-\uDBFF]$/, ""));
const safeLogo = z
  .string()
  .max(2048)
  .refine((value) => {
    if (value === "/gnars.webp") return true;
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  });

export const swapDirectoryTokenSchema = z
  .object({
    address,
    symbol: label,
    name: label,
    decimals: z.number().int().min(0).max(255),
    logo: safeLogo.optional(),
    category: z.enum(["creator", "stock"]),
    source: z.enum(["zora", "clanker", "ondo", "xstocks", "coinbase"]),
    sourceUrl: z.string().url().startsWith("https://").max(2048).optional(),
  })
  .refine((token) =>
    token.category === "creator"
      ? token.source === "zora" || token.source === "clanker"
      : token.source === "ondo" || token.source === "xstocks" || token.source === "coinbase",
  );
export const swapTokenDirectorySchema = z.object({
  tokens: z.array(swapDirectoryTokenSchema).max(100),
  sources: z.object({
    zora: z.object({ available: z.boolean() }),
    clanker: z.object({ available: z.boolean() }),
    stocks: z.object({ available: z.boolean() }),
  }),
});

function logoUrl(raw: string | null | undefined): string | undefined {
  if (!raw || raw.length > 2048) return undefined;
  try {
    const url = new URL(ipfsToHttp(raw));
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function deduplicateDirectoryTokens(
  tokens: readonly SwapDirectoryToken[],
): SwapDirectoryToken[] {
  const seen = new Set<string>();
  return tokens.filter((token) => {
    const key = token.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Only official Zora coin responses establish provenance; symbols are not classification. */
export function parseZoraDirectory(raw: unknown): SwapDirectoryToken[] {
  const response = z
    .object({
      exploreList: z.object({
        edges: z
          .array(
            z.object({
              node: z.object({
                address,
                name: providerLabel,
                symbol: providerLabel,
                chainId: z.number().int(),
                decimals: z.literal(18).optional(),
                mediaContent: z
                  .object({
                    previewImage: z
                      .object({
                        small: z.string().optional(),
                        medium: z.string().optional(),
                      })
                      .nullish(),
                  })
                  .nullish(),
              }),
            }),
          )
          .max(20),
      }),
    })
    .parse(raw);
  return deduplicateDirectoryTokens(
    response.exploreList.edges
      .filter(({ node }) => node.chainId === 8453)
      .map(({ node }) => ({
        address: node.address,
        symbol: node.symbol,
        name: node.name,
        // Zora Coins implement the protocol's 18-decimal ERC20, unlike arbitrary token metadata.
        decimals: 18,
        category: "creator",
        source: "zora",
        logo: logoUrl(
          node.mediaContent?.previewImage?.small ?? node.mediaContent?.previewImage?.medium,
        ),
        sourceUrl: `https://zora.co/coin/base:${node.address.toLowerCase()}`,
      })),
  );
}

/** The deployment index supplies explicit chain and protocol type, never address/name heuristics. */
export function parseClankerDirectory(raw: unknown): SwapDirectoryToken[] {
  const response = z
    .object({
      data: z
        .array(
          z.object({
            contract_address: address,
            name: providerLabel,
            symbol: providerLabel,
            chain_id: z.number().int(),
            type: z.string(),
            factory_address: address,
            decimals: z.literal(18).optional(),
            img_url: z.string().nullish(),
          }),
        )
        .max(20),
    })
    .parse(raw);
  return deduplicateDirectoryTokens(
    response.data
      .filter(
        (token) =>
          token.chain_id === 8453 &&
          ["clanker_v3", "clanker_v3.1", "clanker_v4"].includes(token.type),
      )
      .map((token) => ({
        address: token.contract_address,
        symbol: token.symbol,
        name: token.name,
        decimals: 18,
        category: "creator",
        source: "clanker",
        logo: logoUrl(token.img_url),
        sourceUrl: `https://www.clanker.world/clanker/${token.contract_address.toLowerCase()}`,
      })),
  );
}
