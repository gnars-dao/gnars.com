import "server-only";
import { unstable_cache } from "next/cache";
import { getCoinsTopVolume24h, setApiKey } from "@zoralabs/coins-sdk";
import { getAddress } from "viem";
import { VERIFIED_BASE_STOCK_TOKENS } from "@/data/swap-stock-tokens";
import { DAO_ADDRESSES } from "@/lib/config";
import {
  deduplicateDirectoryTokens,
  parseClankerDirectory,
  parseZoraDirectory,
  type SwapDirectoryToken,
  type SwapTokenDirectory,
} from "@/lib/swap-token-directory";

const gnars: SwapDirectoryToken = {
  address: getAddress(DAO_ADDRESSES.gnarsErc20),
  symbol: "GNARS",
  name: "Gnars",
  decimals: 18,
  logo: "/gnars.webp",
  category: "creator",
  source: "zora",
  sourceUrl: `https://zora.co/coin/base:${DAO_ADDRESSES.gnarsErc20}`,
};

const cachedZora = unstable_cache(
  async () => {
    const key = process.env.NEXT_PUBLIC_ZORA_API_KEY;
    if (key) setApiKey(key);
    const response = await getCoinsTopVolume24h({ count: 20 }, {
      signal: AbortSignal.timeout(8000),
    } as NonNullable<Parameters<typeof getCoinsTopVolume24h>[1]>);
    return parseZoraDirectory(response.data);
  },
  ["swap-token-directory-zora-v1"],
  { revalidate: 300 },
);

const cachedClanker = unstable_cache(
  async () => {
    const response = await fetch(
      "https://www.clanker.world/api/tokens?chainId=8453&limit=20&sortBy=tx-h24&sort=desc",
      {
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!response.ok) throw new Error("Clanker token directory is unavailable");
    return parseClankerDirectory(await response.json());
  },
  ["swap-token-directory-clanker-v1"],
  { revalidate: 300 },
);

const providers = {
  zora: { load: cachedZora, pending: null as Promise<SwapDirectoryToken[]> | null, retryAt: 0 },
  clanker: {
    load: cachedClanker,
    pending: null as Promise<SwapDirectoryToken[]> | null,
    retryAt: 0,
  },
};

async function loadProvider(source: keyof typeof providers) {
  const provider = providers[source];
  if (provider.retryAt > Date.now()) throw new Error("Token directory is temporarily unavailable");
  // Share cold cache misses and back off failures without caching an empty successful feed.
  provider.pending ??= provider
    .load()
    .catch((error) => {
      provider.retryAt = Date.now() + 30_000;
      throw error;
    })
    .finally(() => {
      provider.pending = null;
    });
  return provider.pending;
}

export async function getSwapTokenDirectory(): Promise<SwapTokenDirectory> {
  const [zora, clanker] = await Promise.allSettled([loadProvider("zora"), loadProvider("clanker")]);
  return {
    tokens: deduplicateDirectoryTokens([
      gnars,
      ...VERIFIED_BASE_STOCK_TOKENS,
      ...(zora.status === "fulfilled" ? zora.value : []),
      ...(clanker.status === "fulfilled" ? clanker.value : []),
    ]),
    sources: {
      zora: { available: zora.status === "fulfilled" },
      clanker: { available: clanker.status === "fulfilled" },
      stocks: { available: true },
    },
  };
}
