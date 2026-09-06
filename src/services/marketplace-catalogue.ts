import "server-only";
import { unstable_cache } from "next/cache";
import { erc721Abi, getAddress, zeroAddress, type Address } from "viem";
import { z } from "zod";
import { DAO_ADDRESSES } from "@/lib/config";
import { ipfsToHttp } from "@/lib/ipfs";
import { subgraphQuery } from "@/lib/subgraph";
import {
  MARKETPLACE_CACHE_TAG,
  MARKETPLACE_PAGE_SIZE,
  marketplaceAddressSchema,
  marketplaceClient,
  marketplaceUintSchema,
} from "@/services/marketplace-common";
import type { MarketplaceItem } from "@/types/marketplace";

const responseSchema = z.object({
  tokens: z
    .array(
      z.object({
        tokenId: marketplaceUintSchema,
        image: z.string().max(200000).nullable().optional(),
        ownerInfo: z.object({ owner: marketplaceAddressSchema }).nullable(),
      }),
    )
    .max(48),
});

async function fetchTokens(options: { owner?: Address; before?: string; ids?: string[] }) {
  const { owner, before, ids } = options;
  const query = `query MarketplaceTokens($dao: ID!, $zero: Bytes!${owner ? ", $owner: Bytes!" : ""}${before ? ", $before: BigInt!" : ""}${ids ? ", $ids: [BigInt!]!" : ""}) {
    tokens(first: ${ids ? 48 : MARKETPLACE_PAGE_SIZE}, where: { dao: $dao, owner_not: $zero${owner ? ", owner: $owner" : ""}${before ? ", tokenId_lt: $before" : ""}${ids ? ", tokenId_in: $ids" : ""} }, orderBy: tokenId, orderDirection: desc) {
      tokenId image ownerInfo { owner }
    }
  }`;
  const raw = await subgraphQuery<unknown>(
    query,
    {
      dao: DAO_ADDRESSES.token.toLowerCase(),
      zero: zeroAddress,
      ...(owner ? { owner: owner.toLowerCase() } : {}),
      ...(before ? { before } : {}),
      ...(ids ? { ids } : {}),
    },
    { revalidate: 0, signal: AbortSignal.timeout(8000), label: "marketplace-catalogue" },
  );
  return responseSchema.parse(raw).tokens.map(
    (token): MarketplaceItem => ({
      tokenId: token.tokenId,
      name: `Gnar #${token.tokenId}`,
      image: token.image?.startsWith("ipfs://") ? ipfsToHttp(token.image) : (token.image ?? null),
      owner: token.ownerInfo ? getAddress(token.ownerInfo.owner) : null,
      offers: [],
    }),
  );
}

const cachedCatalogue = unstable_cache(fetchTokens, ["marketplace-catalogue-v2"], {
  revalidate: 60,
  tags: [MARKETPLACE_CACHE_TAG],
});

export async function getMarketplaceCatalogue(owner?: Address, before?: string) {
  const indexed = await cachedCatalogue({ owner, before });
  const nextCursor = indexed.length === MARKETPLACE_PAGE_SIZE ? indexed.at(-1)!.tokenId : null;
  if (!owner || indexed.length === 0) return { items: indexed, nextCursor };
  // The index may lag transfers. Only the current writer's on-chain NFTs are sellable.
  const owners = await marketplaceClient.multicall({
    allowFailure: false,
    contracts: indexed.map((item) => ({
      address: DAO_ADDRESSES.token,
      abi: erc721Abi,
      functionName: "ownerOf" as const,
      args: [BigInt(item.tokenId)],
    })),
  });
  return {
    items: indexed.filter((_, index) => owners[index].toLowerCase() === owner.toLowerCase()),
    nextCursor,
  };
}

export async function getMarketplaceMetadata(ids: string[]) {
  if (ids.length === 0) return [];
  return cachedCatalogue({ ids: [...new Set(ids)].slice(0, 48).sort() });
}
