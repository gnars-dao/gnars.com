import { VERIFIED_BASE_STOCK_TOKENS } from "@/data/swap-stock-tokens";
import { NATIVE_TOKEN, SWAP_CHAINS, type SwapToken } from "./chains";
import { zoraCoinUrl, type ZoraCoinLike } from "./coinCardModel";

export type TokenMetadata = {
  coin: ZoraCoinLike | null;
  source: "zora" | "onchain" | null;
};

export function verifiedStock(token: SwapToken, chainId: number) {
  return chainId === 8453
    ? VERIFIED_BASE_STOCK_TOKENS.find(
        (stock) => stock.address.toLowerCase() === token.address.toLowerCase(),
      )
    : undefined;
}

export function shouldFetchTokenMetadata(token: SwapToken, chainId: number) {
  if (chainId !== 8453 || token.address.toLowerCase() === NATIVE_TOKEN) return false;
  if (verifiedStock(token, chainId)) return false;
  if (token.source) return token.source === "zora";
  return !SWAP_CHAINS.find((chain) => chain.id === chainId)?.tokens.some(
    (known) => known.address.toLowerCase() === token.address.toLowerCase(),
  );
}

export function tokenCardIdentity(
  token: SwapToken,
  chainId: number,
  metadata?: TokenMetadata,
): {
  kind: "zora" | "clanker" | "stock" | "native" | "token";
  href: string | null;
  link: "zora" | "clanker" | "explorer";
  label: string | null;
} {
  const chain = SWAP_CHAINS.find((candidate) => candidate.id === chainId);
  const native = token.address.toLowerCase() === NATIVE_TOKEN;
  const explorer = chain?.thirdwebChain.blockExplorers?.[0]?.url;
  const href = explorer
    ? native
      ? explorer
      : `${explorer.replace(/\/$/, "")}/token/${token.address}`
    : null;
  const base = chainId === 8453;
  // contractURI describes artwork, not the protocol that created the token.
  if (!native && base) {
    if (verifiedStock(token, chainId) || token.category === "stock") {
      return { kind: "stock", href, link: "explorer", label: null };
    }
    if (token.source === "clanker") {
      return {
        kind: "clanker",
        href: `https://www.clanker.world/clanker/${token.address.toLowerCase()}`,
        link: "clanker",
        label: null,
      };
    }
    if (token.source === "zora" || metadata?.source === "zora") {
      return { kind: "zora", href: zoraCoinUrl(token.address), link: "zora", label: null };
    }
  }
  return { kind: native ? "native" : "token", href, link: "explorer", label: chain?.name ?? null };
}
