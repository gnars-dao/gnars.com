import {
  arbitrum as thirdwebArbitrum,
  avalanche as thirdwebAvalanche,
  base as thirdwebBase,
  bsc as thirdwebBsc,
  defineChain,
  ethereum as thirdwebEthereum,
  type Chain as ThirdwebChain,
} from "thirdweb/chains";
import { DAO_ADDRESSES, TREASURY_TOKEN_ALLOWLIST } from "@/lib/config";

// 0x convention for the native asset slot on every chain.
export const NATIVE_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as const;

export interface SwapToken {
  symbol: string;
  name: string;
  address: `0x${string}` | typeof NATIVE_TOKEN;
  decimals: number;
  logo?: string;
}

export interface SwapChain {
  id: number;
  name: string;
  shortName: string;
  thirdwebChain: ThirdwebChain;
  tokens: readonly SwapToken[];
  /** Default sell/buy symbols when the user lands on or switches to this chain. */
  defaults: { sell: string; buy: string };
}

const ETH_LOGO = "https://assets.relay.link/icons/1/light.png" as const;
const USDC_LOGO =
  "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/base/assets/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913/logo.png" as const;

const ETH_NATIVE: SwapToken = {
  symbol: "ETH",
  name: "Ethereum",
  address: NATIVE_TOKEN,
  decimals: 18,
  logo: ETH_LOGO,
};

const BNB_NATIVE: SwapToken = {
  symbol: "BNB",
  name: "BNB",
  address: NATIVE_TOKEN,
  decimals: 18,
  logo: "https://assets.relay.link/icons/56/light.png",
};

const AVAX_NATIVE: SwapToken = {
  symbol: "AVAX",
  name: "Avalanche",
  address: NATIVE_TOKEN,
  decimals: 18,
  logo: "https://assets.relay.link/icons/43114/light.png",
};

/**
 * Robinhood Chain, defined here because thirdweb ships no definition for it.
 *
 * The RPC is given explicitly and is NOT the one in the chain's own registry
 * entry: that host does not resolve from a browser, so a wallet balance read
 * would fail on the client while working in every server-side test.
 */
const thirdwebRobinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpc: "https://robinhood-rpc.publicnode.com",
  blockExplorers: [{ name: "Robinhood", url: "https://explorer.chain.robinhood.com" }],
});

/**
 * The chains the picker offers — exactly the ones SwapsPro routes.
 *
 * This list and `SWAPPRO_CHAINS` in src/lib/swappro.ts must hold the same ids,
 * and chains.test.ts fails when they drift. It is not bookkeeping: Optimism
 * sat here for months and every quote on it came back UNSUPPORTED_CHAIN, so
 * the picker offered a chain that could never fill an order. A chain SwapsPro
 * adds shows up as a failing test rather than as nothing at all.
 */
export const SWAP_CHAINS: readonly SwapChain[] = [
  {
    id: 8453,
    name: "Base",
    shortName: "Base",
    thirdwebChain: thirdwebBase,
    defaults: { sell: "ETH", buy: "MOR" },
    // First 4 tokens appear in the "Popular" chip row of the token picker.
    tokens: [
      {
        symbol: "GNARS",
        name: "Gnars",
        address: DAO_ADDRESSES.gnarsErc20 as `0x${string}`,
        decimals: 18,
        logo: "/gnars.webp",
      },
      {
        symbol: "MOR",
        name: "Morpheus AI",
        address: "0x7431aDa8a591C955a994a21710752EF9b882b8e3",
        decimals: 18,
        logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/base/assets/0x7431aDa8a591C955a994a21710752EF9b882b8e3/logo.png",
      },
      {
        symbol: "HIGHER",
        name: "Higher",
        address: "0x0578d8a44db98b23bf096a382e016e29a5ce0ffe",
        decimals: 18,
        logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/base/assets/0x0578d8A44db98B23BF096A382e016e29a5Ce0ffe/logo.png",
      },
      {
        symbol: "VVV",
        name: "Venice Token",
        address: "0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf",
        decimals: 18,
        logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/base/assets/0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf/logo.png",
      },
      ETH_NATIVE,
      {
        symbol: "WETH",
        name: "Wrapped Ether",
        address: TREASURY_TOKEN_ALLOWLIST.WETH as `0x${string}`,
        decimals: 18,
        logo: ETH_LOGO,
      },
      {
        symbol: "USDC",
        name: "USD Coin",
        address: TREASURY_TOKEN_ALLOWLIST.USDC as `0x${string}`,
        decimals: 6,
        logo: USDC_LOGO,
      },
      {
        symbol: "DEGEN",
        name: "Degen",
        address: "0x4ed4e862860bed51a9570b96d89af5e1b0efefed",
        decimals: 18,
        logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/base/assets/0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed/logo.png",
      },
    ],
  },
  {
    id: 1,
    name: "Ethereum",
    shortName: "Ethereum",
    thirdwebChain: thirdwebEthereum,
    defaults: { sell: "ETH", buy: "USDC" },
    tokens: [
      ETH_NATIVE,
      {
        symbol: "WETH",
        name: "Wrapped Ether",
        address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        decimals: 18,
        logo: ETH_LOGO,
      },
      {
        symbol: "USDC",
        name: "USD Coin",
        address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        decimals: 6,
        logo: USDC_LOGO,
      },
      {
        symbol: "USDT",
        name: "Tether",
        address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
        decimals: 6,
      },
      {
        symbol: "DAI",
        name: "Dai",
        address: "0x6b175474e89094c44da98b954eedeac495271d0f",
        decimals: 18,
      },
    ],
  },
  {
    id: 42161,
    name: "Arbitrum",
    shortName: "ARB",
    thirdwebChain: thirdwebArbitrum,
    defaults: { sell: "ETH", buy: "USDC" },
    tokens: [
      ETH_NATIVE,
      {
        symbol: "WETH",
        name: "Wrapped Ether",
        address: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
        decimals: 18,
        logo: ETH_LOGO,
      },
      {
        symbol: "USDC",
        name: "USD Coin",
        address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
        decimals: 6,
        logo: USDC_LOGO,
      },
      {
        symbol: "ARB",
        name: "Arbitrum",
        address: "0x912ce59144191c1204e64559fe8253a0e49e6548",
        decimals: 18,
      },
    ],
  },
  {
    id: 56,
    name: "BNB Chain",
    shortName: "BNB",
    thirdwebChain: thirdwebBsc,
    defaults: { sell: "BNB", buy: "USDT" },
    tokens: [
      BNB_NATIVE,
      // BNB Chain stables are 18 decimals, not 6. Read from chain on
      // 2026-09-03 rather than copied from the Ethereum list, which is the
      // mistake that turns 35 USDT into 35 trillion.
      {
        symbol: "USDT",
        name: "Tether",
        address: "0x55d398326f99059ff775485246999027b3197955",
        decimals: 18,
      },
      {
        symbol: "USDC",
        name: "USD Coin",
        address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
        decimals: 18,
        logo: USDC_LOGO,
      },
      {
        symbol: "WBNB",
        name: "Wrapped BNB",
        address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
        decimals: 18,
      },
    ],
  },
  {
    id: 43114,
    name: "Avalanche",
    shortName: "AVAX",
    thirdwebChain: thirdwebAvalanche,
    defaults: { sell: "AVAX", buy: "USDC" },
    tokens: [
      AVAX_NATIVE,
      {
        symbol: "USDC",
        name: "USD Coin",
        address: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",
        decimals: 6,
        logo: USDC_LOGO,
      },
      // Avalanche's Tether is "USDt", not "USDT" — the symbol is the token's
      // own, so the picker matches what a block explorer shows.
      {
        symbol: "USDt",
        name: "Tether",
        address: "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7",
        decimals: 6,
      },
      {
        symbol: "WAVAX",
        name: "Wrapped AVAX",
        address: "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7",
        decimals: 18,
      },
    ],
  },
  {
    id: 4663,
    name: "Robinhood Chain",
    shortName: "RHD",
    thirdwebChain: thirdwebRobinhood,
    defaults: { sell: "ETH", buy: "USDG" },
    // Tokenised equities, which is the whole reason this chain is here: a
    // shredder can turn ETH into NVDA without leaving the page.
    tokens: [
      ETH_NATIVE,
      {
        symbol: "USDG",
        name: "Global Dollar",
        address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
        decimals: 6,
      },
      {
        symbol: "NVDA",
        name: "NVIDIA",
        address: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
        decimals: 18,
      },
      {
        symbol: "TSLA",
        name: "Tesla",
        address: "0x322f0929c4625ed5bad873c95208d54e1c003b2d",
        decimals: 18,
      },
      {
        symbol: "WETH",
        name: "Wrapped Ether",
        address: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
        decimals: 18,
        logo: ETH_LOGO,
      },
    ],
  },
] as const;

export const DEFAULT_SWAP_CHAIN = SWAP_CHAINS[0]; // Base

/** Shape returned by /api/wallet/tokens — one entry per ERC-20 the user holds. */
export interface WalletToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  /** Raw balance as a decimal string (BigInt-safe). */
  balance: string;
  /** Human-readable balance string (e.g. "1.2345"). */
  displayBalance: string;
  logoUrl: string | null;
  /** USD value of the holding. Null when the token has no CoinGecko price. */
  usdValue: number | null;
}

export function getSwapChain(id: number): SwapChain {
  return SWAP_CHAINS.find((c) => c.id === id) ?? DEFAULT_SWAP_CHAIN;
}

export function getDefaultPair(chain: SwapChain): { sell: SwapToken; buy: SwapToken } {
  const sell = chain.tokens.find((t) => t.symbol === chain.defaults.sell) ?? chain.tokens[0];
  const buy =
    chain.tokens.find((t) => t.symbol === chain.defaults.buy) ?? chain.tokens[1] ?? chain.tokens[0];
  return { sell, buy };
}
