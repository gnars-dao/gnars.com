"use client";

/**
 * Gnars Migration — data layer (ETH-only).
 *
 * Lists a wallet's scattered Zora coins and quotes each one straight to ETH.
 * ETH is the only asset the UpgraderEth contract accepts (old $gnars, ZORA and
 * USDC revert "Token not eligible"), so every coin — content or creator — is
 * priced as `coin → … → ZORA → ETH`, a single trade the Zora router chains for us.
 *
 * This hook only READS and QUOTES. Execution lives in use-execute-migration.ts.
 */
import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  createTradeCall,
  getProfileBalances,
  setApiKey,
  type TradeParameters,
} from "@zoralabs/coins-sdk";
import { formatUnits, type Address } from "viem";
import { GNARS_CREATOR_COIN, ZORA_TOKEN_BASE } from "@/lib/config";

const BASE_CHAIN_ID = 8453;
const GNARS = GNARS_CREATOR_COIN.toLowerCase();
const ZORA = ZORA_TOKEN_BASE.toLowerCase();

/**
 * Slippage tolerance for the sells. The router enforces the matching
 * amountOutMin, and the deposit leg deposits exactly that minimum, so this is
 * also the upper bound on how much of the proceeds can stay loose in the wallet.
 */
export const MIGRATION_SLIPPAGE = 0.05;

let apiKeyReady = false;
if (typeof window !== "undefined") {
  const key = process.env.NEXT_PUBLIC_ZORA_API_KEY;
  if (key) {
    setApiKey(key);
    apiKeyReady = true;
  } else {
    console.error("[use-gnars-migration] Missing NEXT_PUBLIC_ZORA_API_KEY — quoting disabled");
  }
}

// Zora coins use 18 decimals across the protocol.
const ZORA_COIN_DECIMALS = 18;

/** A single coin the user could migrate. */
export interface MigratableCoin {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  /** Raw balance (BigInt-safe string). */
  balance: string;
  displayBalance: string;
  logoUrl: string | null;
  usdValue: number | null;
  /** Coin market cap (USD) from Zora's indexer. */
  marketCap: number | null;
  /**
   * The token this coin is directly paired with in its Zora pool — the first
   * routing hop. A content coin is paired with its creator coin; a creator
   * coin is paired with ZORA.
   */
  pairedWith: { address: string; name: string } | null;
}

export type CoinKind = "gnars-content" | "creator" | "content" | "other";

export interface RouteHop {
  label: string;
  kind: "coin" | "creator" | "zora" | "eth";
}

/**
 * Human-readable routing path for a coin, always ending in ETH:
 *   content coin → creator coin → ZORA → ETH
 *   creator coin → ZORA → ETH
 * The router collapses these into one trade; this is only for display.
 */
export function buildRoute(coin: MigratableCoin): { kind: CoinKind; hops: RouteHop[] } {
  const paired = coin.pairedWith?.address?.toLowerCase();
  const start: RouteHop = { label: coin.symbol, kind: "coin" };
  const zoraHop: RouteHop = { label: "ZORA", kind: "zora" };
  const ethHop: RouteHop = { label: "ETH", kind: "eth" };

  if (paired === GNARS) {
    // Paired with the old $gnars creator coin, which itself sits on ZORA.
    return {
      kind: "gnars-content",
      hops: [start, { label: "$GNARS", kind: "creator" }, zoraHop, ethHop],
    };
  }
  if (paired === ZORA) {
    return { kind: "creator", hops: [start, zoraHop, ethHop] };
  }
  if (coin.pairedWith) {
    return {
      kind: "content",
      hops: [start, { label: coin.pairedWith.name, kind: "creator" }, zoraHop, ethHop],
    };
  }
  return { kind: "other", hops: [start, zoraHop, ethHop] };
}

/**
 * The connected wallet's Zora-coin holdings, from Zora's own indexer
 * (`getProfileBalances`) — NOT a raw ERC-20 scan, so scam/airdrop tokens never
 * enter the flow. Drops old $gnars (it has its own sell leg) and the ZORA hub.
 */
export function useMigratableCoins(address: string | undefined) {
  const query = useQuery<MigratableCoin[]>({
    queryKey: ["migratable-coins", address?.toLowerCase()],
    enabled: apiKeyReady && Boolean(address),
    staleTime: 60_000,
    queryFn: async () => {
      const resp = await getProfileBalances({
        identifier: (address as string).toLowerCase(),
        count: 200,
        chainIds: [BASE_CHAIN_ID],
        excludeHidden: true,
        sortOption: "USD_VALUE",
      });

      const edges = resp.data?.profile?.coinBalances?.edges ?? [];
      const seen = new Set<string>();
      const coins: MigratableCoin[] = [];

      for (const edge of edges) {
        const node = edge?.node;
        const coin = node?.coin;
        if (!coin?.address || !node?.balance) continue;

        const addr = coin.address.toLowerCase();
        if (addr === GNARS || addr === ZORA || seen.has(addr)) continue;
        if (coin.chainId !== BASE_CHAIN_ID) continue;
        let balance: bigint;
        try {
          balance = BigInt(node.balance);
        } catch {
          continue;
        }
        if (balance <= 0n) continue;
        seen.add(addr);

        const displayBalance = formatUnits(balance, ZORA_COIN_DECIMALS);
        const priceUsd = coin.tokenPrice?.priceInUsdc ? Number(coin.tokenPrice.priceInUsdc) : null;
        const usdValue = priceUsd !== null ? Number(displayBalance) * priceUsd : null;
        const marketCap = coin.marketCap ? Number(coin.marketCap) : null;
        const pairedWith = coin.poolCurrencyToken?.address
          ? {
              address: coin.poolCurrencyToken.address,
              name: coin.poolCurrencyToken.name ?? "ZORA",
            }
          : null;

        coins.push({
          address: coin.address as Address,
          symbol: coin.symbol ?? "?",
          name: coin.name ?? coin.symbol ?? "Unknown coin",
          decimals: ZORA_COIN_DECIMALS,
          balance: balance.toString(),
          displayBalance,
          logoUrl: null,
          usdValue,
          marketCap,
          pairedWith,
        });
      }

      return coins;
    },
  });

  return {
    coins: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}

export interface CoinQuote {
  address: Address;
  /** True when the router found a route to ETH. */
  routable: boolean;
  /** Estimated ETH out (wei). */
  out: bigint;
  error?: string;
}

/** Quotes each selected coin's full balance straight to ETH. */
export function useCoinQuotes(
  coins: MigratableCoin[],
  sender: string | undefined,
  slippage = MIGRATION_SLIPPAGE,
) {
  const results = useQueries({
    queries: coins.map((coin) => ({
      queryKey: ["migration-quote", coin.address.toLowerCase(), coin.balance, sender, slippage],
      enabled: apiKeyReady && Boolean(sender) && BigInt(coin.balance) > 0n,
      staleTime: 30_000,
      retry: false,
      queryFn: async (): Promise<CoinQuote> => {
        const params: TradeParameters = {
          sell: { type: "erc20", address: coin.address },
          buy: { type: "eth" },
          amountIn: BigInt(coin.balance),
          slippage,
          sender: sender as Address,
        };
        try {
          const resp = await createTradeCall(params);
          if (!resp?.success || !resp.quote?.amountOut) {
            return { address: coin.address, routable: false, out: 0n };
          }
          return { address: coin.address, routable: true, out: BigInt(resp.quote.amountOut) };
        } catch (err) {
          return {
            address: coin.address,
            routable: false,
            out: 0n,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    })),
  });

  const quotes = useMemo(
    () => results.map((r) => r.data).filter((q): q is CoinQuote => Boolean(q)),
    [results],
  );
  const isLoading = results.some((r) => r.isLoading);
  const totalEthOut = useMemo(
    () => quotes.reduce((sum, q) => sum + (q.routable ? q.out : 0n), 0n),
    [quotes],
  );

  return { quotes, totalEthOut, isLoading };
}

/** Format a raw amount for display (trims to a sane precision). */
export function formatCoinAmount(raw: bigint, decimals = 18, maxFrac = 4): string {
  const s = formatUnits(raw, decimals);
  const n = Number(s);
  if (n === 0) return "0";
  if (n < 0.0001) return "<0.0001";
  return n.toLocaleString(undefined, { maximumFractionDigits: maxFrac });
}
