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
import { GNARS_CREATOR_COIN, MIGRATE_WALLET_TOKENS_ENABLED, ZORA_TOKEN_BASE } from "@/lib/config";
import { kyberQuoteToEth } from "@/lib/kyber-quote";
import { expectedFromZoraQuote } from "@/lib/route-margin";
import {
  fetchWalletBaseTokens,
  MIN_WALLET_TOKEN_USD,
  MIN_WALLET_TOKEN_WEI,
} from "@/services/wallet-base-tokens";

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

/**
 * Where a holding was found. The two sources are not interchangeable and the UI
 * must keep them apart: "zora" comes from Zora's own curated indexer, "wallet"
 * from a raw ERC-20 balance scan that nobody vetted.
 */
export type CoinSource = "zora" | "wallet";

/** A single coin the user could migrate. */
export interface MigratableCoin {
  address: Address;
  source: CoinSource;
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

export type CoinKind = "gnars-content" | "creator" | "content" | "wallet" | "other";

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

  // A plain wallet token has no Zora pool and never touches the ZORA hub: the
  // aggregator finds its own path, which is one trade as far as the user cares.
  if (coin.source === "wallet") return { kind: "wallet", hops: [start, ethHop] };

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
        // Hidden is a PROFILE-DISPLAY flag, not a quality signal: it means the
        // holder hid the coin from their public Zora profile. That is close to
        // the opposite of "don't migrate this" — a coin you hid is usually one
        // you want out. Excluding them cut a real wallet from 20 coins to 4.
        // Scam/airdrop filtering is already handled by sourcing from Zora's
        // indexer at all instead of a raw ERC-20 scan.
        excludeHidden: false,
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
        // Zora's indexer already renders a preview for every coin; the medium
        // size is the one the coin face is struck from, the small one is only
        // ever a 32px avatar. Falling through to the original URI would hand us
        // an ipfs:// that no <img> can load.
        const preview = coin.mediaContent?.previewImage;
        const logoUrl = preview?.medium || preview?.small || null;
        const pairedWith = coin.poolCurrencyToken?.address
          ? {
              address: coin.poolCurrencyToken.address,
              name: coin.poolCurrencyToken.name ?? "ZORA",
            }
          : null;

        coins.push({
          address: coin.address as Address,
          source: "zora",
          symbol: coin.symbol ?? "?",
          name: coin.name ?? coin.symbol ?? "Unknown coin",
          decimals: ZORA_COIN_DECIMALS,
          balance: balance.toString(),
          displayBalance,
          logoUrl,
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

/**
 * The connected wallet's plain Base ERC-20 holdings — a raw balance scan, in
 * deliberate contrast to `useMigratableCoins` above. Everything it returns is a
 * CANDIDATE: the metadata filter has run (see services/wallet-base-tokens.ts)
 * but the value floor has not, because that needs a quote. Callers must not
 * render a candidate before its quote has cleared `passesWalletValueFloor`.
 */
export function useWalletBaseTokenCandidates(address: string | undefined) {
  const query = useQuery<MigratableCoin[]>({
    queryKey: ["migratable-wallet-tokens", address?.toLowerCase()],
    enabled: MIGRATE_WALLET_TOKENS_ENABLED && Boolean(address),
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const tokens = await fetchWalletBaseTokens(address as string, { signal });
      return tokens.map((t) => ({
        address: t.address as Address,
        source: "wallet" as const,
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals,
        balance: t.balance,
        displayBalance: t.displayBalance,
        logoUrl: t.logoUrl,
        usdValue: t.usdValue,
        // Neither figure exists outside Zora's indexer. Null is the honest
        // answer; the UI already renders "no USD value" rather than "$0".
        marketCap: null,
        pairedWith: null,
      }));
    },
  });

  return {
    candidates: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}

/**
 * Both holdings sources, deduplicated but NOT concatenated — the page has to be
 * able to label them apart, so it gets them apart.
 *
 * A token present in both is kept as the Zora record: Zora's indexer carries
 * the pricing metadata (USD value, market cap, pool pairing, preview image)
 * that the Alchemy scan cannot supply, and its quote routes through Zora's own
 * router rather than the aggregator.
 */
export function useMigrationHoldings(address: string | undefined) {
  const zora = useMigratableCoins(address);
  const wallet = useWalletBaseTokenCandidates(address);

  const walletCandidates = useMemo(() => {
    const known = new Set(zora.coins.map((c) => c.address.toLowerCase()));
    // Same two exclusions the Zora source makes: old $gnars has its own sell
    // leg on this page, and ZORA is the hub every Zora route passes through.
    return wallet.candidates.filter((c) => {
      const addr = c.address.toLowerCase();
      return addr !== GNARS && addr !== ZORA && !known.has(addr);
    });
  }, [wallet.candidates, zora.coins]);

  return {
    zoraCoins: zora.coins,
    walletCandidates,
    isLoading: zora.isLoading,
    isError: zora.isError,
    refetch: zora.refetch,
    walletIsLoading: wallet.isLoading,
    walletIsError: wallet.isError,
    walletRefetch: wallet.refetch,
  };
}

export type QuoteStatus = "routable" | "no-route" | "quote-failed";
export type QuoteProvider = "zora" | "kyber";

export interface CoinQuote {
  address: Address;
  /** Which router answered. Zora is asked first; Kyber when Zora fails or has no route. */
  provider?: QuoteProvider;
  /**
   * Three states, kept apart on purpose: a dead pool ("no-route") and a quote
   * service that fell over ("quote-failed") must never look the same.
   */
  status: QuoteStatus;
  /** True when the router found a route to ETH. */
  routable: boolean;
  /** Expected ETH out (wei), before slippage. */
  out: bigint;
  /** USD value of `out` when the router reports one. Kyber does; Zora does not. */
  outUsd: number | null;
  error?: string;
}

/**
 * Value floor for an UNCURATED wallet token, applied to what the sell would
 * actually deliver rather than to any self-reported price. Zora coins are not
 * subject to it — they come from a curated source and the user asked for them.
 */
export function passesWalletValueFloor(quote: CoinQuote): boolean {
  if (!quote.routable) return false;
  if (quote.outUsd !== null) return quote.outUsd >= MIN_WALLET_TOKEN_USD;
  return quote.out >= MIN_WALLET_TOKEN_WEI;
}

/** Quote one token straight through the aggregator. Never asks Zora. */
async function quoteViaKyber(address: Address, amountIn: bigint): Promise<CoinQuote> {
  try {
    const k = await kyberQuoteToEth(address, amountIn);
    if (!k) return { address, status: "no-route", routable: false, out: 0n, outUsd: null };
    const usd = Number(k.routeSummary.amountOutUsd);
    return {
      address,
      provider: "kyber",
      status: "routable",
      routable: true,
      out: k.amountOut,
      outUsd: Number.isFinite(usd) && usd > 0 ? usd : null,
    };
  } catch (err) {
    // A dead pool and a service outage stay different answers on purpose.
    return {
      address,
      status: "quote-failed",
      routable: false,
      out: 0n,
      outUsd: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
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
      // A wallet token is quoted by the aggregator alone, so it does not need
      // Zora's API key; a Zora coin asks Zora first and does.
      enabled:
        (coin.source === "wallet" || apiKeyReady) && Boolean(sender) && BigInt(coin.balance) > 0n,
      staleTime: 30_000,
      retry: false,
      queryFn: async (): Promise<CoinQuote> => {
        const amountIn = BigInt(coin.balance);
        // Zora's router only knows Zora coins: asking it about a plain ERC-20
        // is a request that is known in advance to fail, so skip it entirely.
        if (coin.source === "wallet") return quoteViaKyber(coin.address, amountIn);
        const params: TradeParameters = {
          sell: { type: "erc20", address: coin.address },
          buy: { type: "eth" },
          amountIn,
          slippage,
          sender: sender as Address,
        };
        let zora: CoinQuote;
        try {
          const resp = await createTradeCall(params);
          zora =
            !resp?.success || !resp.quote?.amountOut
              ? {
                  address: coin.address,
                  status: "no-route",
                  routable: false,
                  out: 0n,
                  outUsd: null,
                }
              : {
                  address: coin.address,
                  provider: "zora",
                  status: "routable",
                  routable: true,
                  // Zora returns the post-slippage minimum; show what is expected.
                  out: expectedFromZoraQuote(BigInt(resp.quote.amountOut), slippage),
                  outUsd: null,
                };
        } catch (err) {
          zora = {
            address: coin.address,
            status: "quote-failed",
            routable: false,
            out: 0n,
            outUsd: null,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        if (zora.routable) return zora;
        // Second opinion: Kyber routes the same v4 hook pools. A Kyber answer
        // upgrades "no route" to a real quote; a Kyber failure changes nothing —
        // the Zora verdict (dead pool vs. service down) stands.
        try {
          const k = await kyberQuoteToEth(coin.address, amountIn);
          if (k) {
            const usd = Number(k.routeSummary.amountOutUsd);
            return {
              address: coin.address,
              provider: "kyber",
              status: "routable",
              routable: true,
              out: k.amountOut,
              outUsd: Number.isFinite(usd) && usd > 0 ? usd : null,
            };
          }
        } catch {
          // keep Zora's verdict
        }
        return zora;
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
  const failedCount = quotes.filter((q) => q.status === "quote-failed").length;
  const refetchFailed = () => {
    results.forEach((r) => {
      if (r.data?.status === "quote-failed") void r.refetch();
    });
  };

  return { quotes, totalEthOut, isLoading, failedCount, refetchFailed };
}

/** Format a raw amount for display (trims to a sane precision). */
export function formatCoinAmount(raw: bigint, decimals = 18, maxFrac = 4): string {
  const s = formatUnits(raw, decimals);
  const n = Number(s);
  if (n === 0) return "0";
  if (n < 0.0001) return "<0.0001";
  return n.toLocaleString(undefined, { maximumFractionDigits: maxFrac });
}
