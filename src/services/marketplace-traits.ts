import "server-only";
import { unstable_cache } from "next/cache";
import { erc721Abi, getAddress, type Address } from "viem";
import { IPFS_GATEWAYS, ipfsToHttp } from "@/lib/ipfs";
import {
  decodeInlineNftMetadata,
  NFT_METADATA_MAX_BYTES,
  NFT_TOKEN_URI_MAX_LENGTH,
  parseNftMetadataJson,
  parseNftTraits,
  type MarketplaceTrait,
} from "@/lib/marketplace/nft-metadata";
import {
  MARKETPLACE_CACHE_TAG,
  marketplaceClient,
  marketplaceUnavailable,
} from "@/services/marketplace-common";

export type MarketplaceTraits = {
  collectionAddress: Address;
  tokenId: string;
  traits: MarketplaceTrait[];
  source: "tokenURI";
};

async function boundedMetadata(response: Response) {
  if (!response.ok || !response.body) throw new Error("NFT metadata provider failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > NFT_METADATA_MAX_BYTES) {
        await reader.cancel();
        throw new Error("NFT metadata is too large");
      }
      chunks.push(value);
    }
    return parseNftMetadataJson(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } finally {
    reader.releaseLock();
  }
}

async function tokenMetadata(uri: string): Promise<unknown> {
  if (uri.length > NFT_TOKEN_URI_MAX_LENGTH) throw new Error("NFT token URI is too large");
  if (uri.startsWith("data:")) return decodeInlineNftMetadata(uri);
  if (uri.length > 8192) throw new Error("NFT token URI is too large");
  // Match the community artwork reader's fixed-gateway policy. Arbitrary HTTPS is never fetched.
  const url = new URL(ipfsToHttp(uri));
  const gateway = new URL(IPFS_GATEWAYS[0]);
  const path = decodeURIComponent(url.pathname.slice(gateway.pathname.length));
  if (
    url.origin !== gateway.origin ||
    !url.pathname.startsWith(gateway.pathname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,100})(\/|$)/.test(path) ||
    path.split("/").some((part) => part === "." || part === "..") ||
    /[\\\x00-\x1f]/.test(path)
  )
    throw new Error("Unsupported NFT token URI");
  for (const base of IPFS_GATEWAYS) {
    try {
      return await boundedMetadata(
        await fetch(`${base}${url.pathname.slice(gateway.pathname.length)}`, {
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(2000),
        }),
      );
    } catch {
      // Retry only the fixed gateway list; failures must not become an empty cached trait set.
    }
  }
  throw new Error("NFT metadata gateways unavailable");
}

const cachedTraits = unstable_cache(
  async (collectionAddress: Address, tokenId: string): Promise<MarketplaceTraits> => {
    try {
      if ((await marketplaceClient.getChainId()) !== 8453) throw new Error("Wrong chain");
      const uri = await marketplaceClient.readContract({
        address: collectionAddress,
        abi: erc721Abi,
        functionName: "tokenURI",
        args: [BigInt(tokenId)],
      });
      if (typeof uri !== "string") throw new Error("Invalid NFT token URI");
      return {
        collectionAddress,
        tokenId,
        traits: parseNftTraits(await tokenMetadata(uri)),
        source: "tokenURI",
      };
    } catch {
      throw marketplaceUnavailable("NFT traits could not be loaded.");
    }
  },
  ["marketplace-token-traits-v1"],
  { revalidate: 300, tags: [MARKETPLACE_CACHE_TAG] },
);

export function getMarketplaceTraits(collection: Address, tokenId: string) {
  return cachedTraits(getAddress(collection), BigInt(tokenId).toString());
}
