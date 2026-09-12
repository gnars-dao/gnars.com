import { unstable_cache } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { getCoins, setApiKey } from "@zoralabs/coins-sdk";
import { formatUnits, getAddress, isAddress } from "viem";
import { z } from "zod";
import type { WalletToken } from "@/app/[locale]/swap/chains";
import { isBelowMinimumZoraMarketCap } from "@/lib/zora-market-cap";

const ALCHEMY_RPC_BASES: Record<string, string> = {
  "8453": "https://base-mainnet.g.alchemy.com/v2",
  "1": "https://eth-mainnet.g.alchemy.com/v2",
  "10": "https://opt-mainnet.g.alchemy.com/v2",
  "42161": "https://arb-mainnet.g.alchemy.com/v2",
};

const TRUSTWALLET_CHAIN_NAMES: Record<string, string> = {
  "8453": "base",
  "1": "ethereum",
  "10": "optimism",
  "42161": "arbitrum",
};

// CoinGecko platform IDs for token price lookups.
const COINGECKO_PLATFORMS: Record<string, string> = {
  "8453": "base",
  "1": "ethereum",
  "10": "optimistic-ethereum",
  "42161": "arbitrum-one",
};

type AlchemyMetaResult = {
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  logo: string | null;
};

const balanceResponseSchema = z.object({
  id: z.literal(1),
  result: z.object({
    tokenBalances: z
      .array(
        z.object({
          contractAddress: z
            .string()
            .refine(isAddress)
            .transform((address) => address.toLowerCase()),
          tokenBalance: z.string().regex(/^0x[0-9a-fA-F]+$/),
          error: z.null().optional(),
        }),
      )
      .max(1000),
  }),
  error: z.undefined().optional(),
});

const metadataResponseSchema = z.array(
  z.object({
    id: z.number().int().positive(),
    result: z.object({
      name: z.string().nullable(),
      symbol: z.string().nullable(),
      decimals: z.number().int().min(0).max(255).nullable(),
      logo: z.string().nullable(),
    }),
    error: z.undefined().optional(),
  }),
);

function rpcUrlForChain(chainId: string) {
  const base = ALCHEMY_RPC_BASES[chainId];
  const key = process.env.ALCHEMY_API_KEY;
  if (!base || !key) throw new Error("Alchemy is not configured for this chain");
  return `${base}/${key}`;
}

const getCachedBalances = unstable_cache(
  async (chainId: string, address: string) => {
    const response = await fetch(rpcUrlForChain(chainId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "alchemy_getTokenBalances",
        params: [address, "erc20"],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error("Alchemy balance request failed");
    return balanceResponseSchema.parse(await response.json()).result.tokenBalances;
  },
  ["wallet-alchemy-balances-v2"],
  { revalidate: 15 },
);

const getCachedMetadataBatch = unstable_cache(
  async (chainId: string, addresses: string[]) => {
    const response = await fetch(rpcUrlForChain(chainId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        addresses.map((address, index) => ({
          id: index + 1,
          jsonrpc: "2.0",
          method: "alchemy_getTokenMetadata",
          params: [address],
        })),
      ),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error("Alchemy metadata request failed");
    const rows = metadataResponseSchema.parse(await response.json());
    const ids = new Set(rows.map((row) => row.id));
    if (
      rows.length !== addresses.length ||
      ids.size !== addresses.length ||
      rows.some((row) => row.id > addresses.length)
    ) {
      throw new Error("Incomplete Alchemy metadata response");
    }
    return rows.map((row) => ({ address: addresses[row.id - 1], metadata: row.result }));
  },
  ["wallet-alchemy-metadata-v2"],
  { revalidate: 3600 },
);

async function fetchMetadataByAddress(chainId: string, addresses: string[]) {
  const canonical = [...new Set(addresses)].sort();
  const metadata = new Map<string, AlchemyMetaResult>();
  for (let index = 0; index < canonical.length; index += 25) {
    const batch = await getCachedMetadataBatch(chainId, canonical.slice(index, index + 25));
    for (const item of batch) metadata.set(item.address, item.metadata);
  }
  return metadata;
}

/** Zora's GraphQL API rejects batches larger than this. */
const ZORA_BATCH_SIZE = 20;

type ZoraCoinSummary = {
  marketCap?: string | number | null;
};

const getCachedZoraBatch = unstable_cache(
  async (addresses: string[]) => {
    const key = process.env.NEXT_PUBLIC_ZORA_API_KEY;
    if (key) setApiKey(key);
    const result = await getCoins(
      {
        coins: addresses.map((collectionAddress) => ({ chainId: 8453, collectionAddress })),
      },
      { signal: AbortSignal.timeout(8000) } as NonNullable<Parameters<typeof getCoins>[1]>,
    );
    if (!result.data?.zora20Tokens) throw new Error("Zora metadata request failed");
    // Zora answers positionally: every address that is NOT a Zora coin comes
    // back as a literal `null` in the array. Reading `.address` off those threw
    // and turned the whole route into a 502 for any wallet holding a plain
    // ERC-20 — i.e. almost every real wallet. They are simply "not a Zora coin".
    return result.data.zora20Tokens
      .filter((coin): coin is NonNullable<typeof coin> => Boolean(coin?.address))
      .map((coin) => ({
        address: coin.address.toLowerCase(),
        marketCap: coin.marketCap,
      }));
  },
  ["wallet-zora-metadata-v1"],
  { revalidate: 300 },
);

async function fetchZoraCoinsByAddress(
  chainId: string,
  tokens: { contractAddress: string }[],
): Promise<Map<string, ZoraCoinSummary>> {
  if (chainId !== "8453" || tokens.length === 0) return new Map();

  const addresses = [...new Set(tokens.map((token) => token.contractAddress.toLowerCase()))].sort();
  const coins = new Map<string, ZoraCoinSummary>();
  // Bound upstream concurrency and request size for wallets with many tokens.
  // 20 is Zora's own hard limit ("Too many coin ids requested. The max batch
  // size is 20"); asking for 25 made every wallet holding more than 20 tokens
  // fail the whole request.
  for (let i = 0; i < addresses.length; i += ZORA_BATCH_SIZE) {
    const batch = await getCachedZoraBatch(addresses.slice(i, i + ZORA_BATCH_SIZE));
    for (const coin of batch) coins.set(coin.address, coin);
  }
  return coins;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const address = searchParams.get("address");
    const chainId = searchParams.get("chainId") ?? "8453";

    if (!address || !isAddress(address)) {
      return NextResponse.json({ error: "Invalid address" }, { status: 400 });
    }

    const rpcBase = ALCHEMY_RPC_BASES[chainId];
    if (!rpcBase) {
      return NextResponse.json({ error: "Unsupported chain" }, { status: 400 });
    }

    const alchemyKey = process.env.ALCHEMY_API_KEY;
    if (!alchemyKey) {
      return NextResponse.json({ error: "Not configured" }, { status: 500 });
    }

    // Short-lived balance snapshots coalesce repeated wallet openings.
    const rawBalances = await getCachedBalances(chainId, address.toLowerCase());
    const nonZero = rawBalances.filter((token) => BigInt(token.tokenBalance) > 0n);

    const cacheHeaders = { "Cache-Control": "public, s-maxage=15, stale-while-revalidate=15" };
    if (nonZero.length === 0) return NextResponse.json([], { headers: cacheHeaders });

    // 2. Fetch metadata and CoinGecko prices in parallel.
    const cgKey = process.env.COINGECKO_API_KEY;
    const cgPlatform = COINGECKO_PLATFORMS[chainId];
    const cgAddresses = nonZero.map((t) => t.contractAddress).join(",");
    const cgUrl = cgPlatform
      ? `https://api.coingecko.com/api/v3/simple/token_price/${cgPlatform}?contract_addresses=${cgAddresses}&vs_currencies=usd`
      : null;

    const [metadataByAddress, cgRes, zoraCoinsByAddress] = await Promise.all([
      fetchMetadataByAddress(
        chainId,
        nonZero.map((token) => token.contractAddress),
      ),
      cgUrl && cgKey
        ? fetch(cgUrl, {
            headers: { "x-cg-demo-api-key": cgKey },
            next: { revalidate: 300 }, // prices: 5-min cache
            signal: AbortSignal.timeout(8000),
          })
        : Promise.resolve(null),
      fetchZoraCoinsByAddress(chainId, nonZero),
    ]);

    // CoinGecko returns lowercase addresses as keys.
    const cgPrices: Record<string, { usd?: number }> = cgRes?.ok ? await cgRes.json() : {};

    const twChainName = TRUSTWALLET_CHAIN_NAMES[chainId];

    const tokens: WalletToken[] = nonZero
      .map((t): WalletToken | null => {
        const meta = metadataByAddress.get(t.contractAddress);
        if (!meta?.symbol || !meta?.name || meta.decimals == null) return null;

        const checksumAddr = getAddress(t.contractAddress);
        const zoraCoin = zoraCoinsByAddress.get(checksumAddr.toLowerCase());
        if (zoraCoin && isBelowMinimumZoraMarketCap(zoraCoin.marketCap)) return null;

        const rawValue = BigInt(t.tokenBalance);
        const displayBalance = formatUnits(rawValue, meta.decimals);

        const price = cgPrices[t.contractAddress.toLowerCase()]?.usd ?? null;
        const usdValue = price !== null ? parseFloat(displayBalance) * price : null;

        const twLogo = twChainName
          ? `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${twChainName}/assets/${checksumAddr}/logo.png`
          : null;

        return {
          address: checksumAddr,
          symbol: meta.symbol,
          name: meta.name,
          decimals: meta.decimals,
          balance: rawValue.toString(),
          displayBalance,
          logoUrl: meta.logo ?? twLogo,
          usdValue,
        };
      })
      .filter((t): t is WalletToken => {
        if (!t) return false;
        // Drop dust/spam: tokens with a known USD value below $0.50.
        // Tokens with no CoinGecko price (usdValue === null) are kept —
        // they may be legitimate tokens not yet listed.
        if (t.usdValue !== null && t.usdValue < 0.5) return false;
        return true;
      })
      // Sort by USD value desc; fall back to normalised balance for unlisted tokens.
      .sort((a, b) => {
        if (a.usdValue !== null && b.usdValue !== null) return b.usdValue - a.usdValue;
        if (a.usdValue !== null) return -1;
        if (b.usdValue !== null) return 1;
        return parseFloat(b.displayBalance) - parseFloat(a.displayBalance);
      });

    return NextResponse.json(tokens, { headers: cacheHeaders });
  } catch (error) {
    console.error("[wallet/tokens] request failed", error);
    return NextResponse.json(
      { error: "Unable to load wallet tokens" },
      {
        status: 502,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
