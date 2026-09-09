import { cache } from "react";
import { BASE_URL, TREASURY_TOKEN_ADDRESSES } from "@/lib/config";
import { getBrlRateForRequest } from "@/services/exchange-rate";
import { getTokenPricesUsd } from "@/services/prices";
import { EnrichedToken, TokenHoldingsClient } from "./TokenHoldingsClient";

interface TokenBalance {
  contractAddress?: string;
  tokenBalance?: string;
}

interface TokenBalancesResponse {
  result?: {
    tokenBalances?: TokenBalance[];
  };
}

interface TokenMetadataResponse {
  result?: {
    decimals?: number;
    logo?: string;
    name?: string;
    symbol?: string;
  };
}

export const loadTokenHoldings = cache(
  async (treasuryAddress: string): Promise<EnrichedToken[]> => {
    const baseUrl = getBaseUrl();

    const balancesResponse = await fetchJson<TokenBalancesResponse>(`${baseUrl}/api/alchemy`, {
      method: "POST",
      body: JSON.stringify({
        method: "alchemy_getTokenBalances",
        params: [treasuryAddress, TREASURY_TOKEN_ADDRESSES.filter(Boolean)],
      }),
    });

    const balances = (balancesResponse.result?.tokenBalances ?? []).filter((token) => {
      const balance = token.tokenBalance?.toLowerCase();
      return balance && balance !== "0" && balance !== "0x0";
    });

    if (!balances.length) {
      return [];
    }

    const metadataResults = await Promise.all(
      balances.map(async (token) => {
        if (!token.contractAddress) return null;
        try {
          return await fetchJson<TokenMetadataResponse>(`${baseUrl}/api/alchemy`, {
            method: "POST",
            body: JSON.stringify({
              method: "alchemy_getTokenMetadata",
              params: [token.contractAddress],
            }),
          });
        } catch {
          return null;
        }
      }),
    );

    const tokensWithMetadata: EnrichedToken[] = [];
    for (let index = 0; index < balances.length; index += 1) {
      const token = balances[index];
      const metadata = metadataResults[index]?.result;
      if (
        !token.contractAddress ||
        !metadata?.symbol ||
        !metadata.name ||
        metadata.decimals === undefined
      ) {
        continue;
      }

      const decimals = Number(metadata.decimals);
      const raw = token.tokenBalance ?? "0x0";
      const parsed = Number.parseInt(raw, 16);
      const balance = Number.isFinite(parsed) ? parsed / Math.pow(10, decimals) : 0;

      tokensWithMetadata.push({
        contractAddress: token.contractAddress,
        balance,
        decimals,
        symbol: metadata.symbol,
        name: metadata.name,
        logo: metadata.logo,
        usdValue: null,
      });
    }

    if (!tokensWithMetadata.length) {
      return [];
    }

    // Server-side already — read the service directly instead of this module
    // making an HTTP round trip to the app's own /api/prices.
    const priceMap = await getTokenPricesUsd(
      tokensWithMetadata.map((token) => token.contractAddress.toLowerCase()),
      "base",
    );

    for (const token of tokensWithMetadata) {
      const price = priceMap[token.contractAddress.toLowerCase()];
      // `null` = unpriceable. Leave usdValue null rather than claiming $0, which
      // is a real balance the UI would otherwise show as worthless.
      token.usdValue = price == null ? null : price * token.balance;
    }

    // Sort tokens by USD value descending for a friendlier presentation.
    // Unpriced tokens sort last rather than being treated as worth $0.
    tokensWithMetadata.sort((a, b) => (b.usdValue ?? -1) - (a.usdValue ?? -1));

    return tokensWithMetadata;
  },
);

/**
 * `BASE_URL` from config, NOT `headers()`.
 *
 * Reading `headers()` during render is a dynamic API: it opted /treasury out of
 * caching entirely, so the page rendered from scratch on every single request
 * (`x-vercel-cache: MISS`, ~750 ms) despite the segment declaring
 * `revalidate = 300`. services/treasury.ts already resolves its own base URL
 * from config for the same self-`/api/alchemy` calls, so this is the two paths
 * agreeing rather than a new convention.
 *
 * The trade is deliberate: previews now call the canonical site's API route
 * instead of their own deployment's. That only matters if a preview changes
 * /api/alchemy itself, and `NEXT_PUBLIC_SITE_URL` overrides it per environment
 * when it does.
 */
function getBaseUrl() {
  return BASE_URL;
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    // Matches the segment's own `revalidate = 300`. A request-scoped
    // `no-store` here would force the route dynamic again on its own, which is
    // half of what kept /treasury uncached.
    next: { revalidate: 300 },
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

interface TokenHoldingsProps {
  treasuryAddress: string;
}

export async function TokenHoldings({ treasuryAddress }: TokenHoldingsProps) {
  let tokens: Awaited<ReturnType<typeof loadTokenHoldings>> = [];
  let error: string | undefined;
  try {
    tokens = await loadTokenHoldings(treasuryAddress);
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load token holdings";
  }
  const brlRate = await getBrlRateForRequest();
  return <TokenHoldingsClient tokens={tokens} error={error} brlRate={brlRate} />;
}
