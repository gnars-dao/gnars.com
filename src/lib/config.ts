import { parseMigrationEnv } from "@/lib/migration-config";

// Development mode flag - use NEXT_PUBLIC prefix so it's available in browser
// This allows runtime checking instead of build-time replacement
export const IS_DEV = process.env.NODE_ENV === "development";

export const CHAIN = {
  id: 8453,
  name: "base",
} as const;

// Core Builder DAO addresses — override via env vars to deploy for a different DAO
export const DAO_ADDRESSES = {
  token: (process.env.NEXT_PUBLIC_TOKEN_ADDRESS ||
    "0x880fb3cf5c6cc2d7dfc13a993e839a9411200c17") as `0x${string}`,
  auction: (process.env.NEXT_PUBLIC_AUCTION_ADDRESS ||
    "0x494eaa55ecf6310658b8fc004b0888dcb698097f") as `0x${string}`,
  governor: (process.env.NEXT_PUBLIC_GOVERNOR_ADDRESS ||
    "0x3dd4e53a232b7b715c9ae455f4e732465ed71b4c") as `0x${string}`,
  treasury: (process.env.NEXT_PUBLIC_TREASURY_ADDRESS ||
    "0x72ad986ebac0246d2b3c565ab2a1ce3a14ce6f88") as `0x${string}`,
  metadata: (process.env.NEXT_PUBLIC_METADATA_ADDRESS ||
    "0xdc9799d424ebfdcf5310f3bad3ddcce3931d4b58") as `0x${string}`,
  gnarsErc20: "0x0cf0c3b75d522290d7d12c74d7f1f0cc47ccb23b", // $GNARS ERC20 token
} as const;

export const ZORA_CREATOR = {
  base: "0x0cf0c3b75d522290d7d12c74d7f1f0cc47ccb23b",
} as const;

// Gnars Creator Coin (used as backing currency for content coins)
// This is the official GNARS creator coin on Base used for pairing content coins
export const GNARS_CREATOR_COIN = "0x0cf0c3b75d522290d7d12c74d7f1f0cc47ccb23b" as const;

// Gnars Zora profile handle - used by SDK to resolve the GNARS creator coin
// The SDK expects a profile identifier (handle or wallet), not the token address directly
export const GNARS_ZORA_HANDLE = "gnars" as const;

// ZORA protocol token on Base — the routing hub for the Gnars Migration tool.
// Every Zora coin routes to ZORA (Zora V4 hooks auto-hop content → creator → ZORA),
// and ZORA → $gnars is a supported creator-coin trade. Verified on-chain (symbol "ZORA").
export const ZORA_TOKEN_BASE = "0x1111111111166b7FE7bd91427724B487980aFc69" as const;

// Interim operational signer for the migration. During the migration the DAO
// uses a temporary multisig (fast, no per-step governance proposal) to receive
// migration proceeds, the Clanker founder-vault allocation, and collected fees.
// Once tokens are fully migrated and fees settled, this multisig sweeps
// everything to the DAO treasury in a single governed move.
//
// Verified on-chain 2026-07-22: a Safe multisig on Base (v1.3.0, 3-of-N threshold).
// This is also the address we ask the Upgrader operator to set as the founder-vault
// beneficiary. Overridable via NEXT_PUBLIC_MIGRATION_MULTISIG.
export const MIGRATION_MULTISIG = (process.env.NEXT_PUBLIC_MIGRATION_MULTISIG ||
  "0xBe6C3D651d2F6e9eFA562b5a7CDf411304cad076") as `0x${string}`;

// --- UpgraderEth: deposit / withdraw / claim (operated by Onchain Inc / kompreni) ---
// ETH is the ONLY eligible lane. Verified on-chain 2026-09-01 by simulating
// deposit(): old $gnars, ZORA and USDC revert "Token not eligible"; address(0)
// (native ETH) is the single entry in getTokens(0).
//
// These defaulted to EMPTY while the terminal waited on a go-ahead. Vlad gave it
// on 2026-09-03, so the deposit terminal is on by default and no longer depends
// on env vars being present on the host.
//
// The defaults were verified against Base 8453 the same day, before being
// written here: the contract exists (10185 bytes of code), isHalted() is false,
// getBuyToken(0) is the zero address (the launch has not run, so deposits and
// withdrawals are open), and getTokens(0) is exactly [address(0)] — native ETH
// as the only eligible asset, matching the ETH-only note above.
//
// Env still WINS over these, which is what keeps a kill switch that needs no
// deploy: set NEXT_PUBLIC_UPGRADER_ADDRESS to an empty string and the terminal
// goes back to "opens at launch". Emptying it has to disable the id as well —
// an address without an id is a mismatched pair, and parseMigrationEnv rightly
// renders that as a red misconfiguration rather than a clean off.
const MIGRATION_DEFAULTS = {
  upgraderAddress: "0x064fd3d95f322909489dc085bb0044a343191ad3",
  upgradeId: "0",
} as const;
// `??` not `||`: an explicit "" is the operator turning this off, and must not
// fall back to the default.
const upgraderEnv = process.env.NEXT_PUBLIC_UPGRADER_ADDRESS ?? MIGRATION_DEFAULTS.upgraderAddress;
const disabled = upgraderEnv.trim() === "";
const migrationEnv = parseMigrationEnv({
  upgraderAddress: upgraderEnv,
  upgradeId: disabled
    ? ""
    : (process.env.NEXT_PUBLIC_MIGRATION_UPGRADE_ID ?? MIGRATION_DEFAULTS.upgradeId),
});
export const UPGRADER_ADDRESS = migrationEnv.upgraderAddress;
export const MIGRATION_UPGRADE_ID = migrationEnv.upgradeId;
export const MIGRATION_CONFIG_ERROR = migrationEnv.error;

/** Deposit / withdraw / claim UI is live only with a contract AND an upgrade id. */
export const isMigrationDepositLive = () =>
  UPGRADER_ADDRESS !== null && MIGRATION_UPGRADE_ID !== null;

// Uniswap Permit2 (canonical, same address on every chain). The smart-account
// batch grants the router its allowance here onchain instead of signing a permit.
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

// Trade referrer for the migration/buy swaps — earns a share of the Zora trade
// fee, claimable in Zora by this account. Set to haxixe.eth (Vlad's personal
// account) so rewards are easy to claim.
// ⚠️ Not yet wired: the Zora SDK's tradeCoin/createTradeCall do NOT forward a
// referrer. Capturing it requires POSTing to the quote endpoint with `referrer`
// in the body and executing the returned call ourselves (see handoff doc).
export const MIGRATION_TRADE_REFERRER = (process.env.NEXT_PUBLIC_MIGRATION_TRADE_REFERRER ||
  "0x8Bf5941d27176242745B716251943Ae4892a3C26") as `0x${string}`;

// Creator allowlist — Zora handles that bypass the NFT qualification gate.
// Use for known community members whose wallets are fragmented across profiles.
export const GNARS_CREATOR_ALLOWLIST: readonly string[] = [
  "skatehacker", // vlad — NFTs on skateboard/maconhinha.base.eth wallets
  "nogenta", // nogenta — 9 NFTs, may fall outside top-200 subgraph scan
] as const;

// Zora Factory contract on Base
export const ZORA_FACTORY_ADDRESS = "0x777777751622c0d3258f214F9DF38E35BF45baF3" as const;

// Platform referrer for Zora coin creation (Gnars DAO treasury receives referral rewards)
export const PLATFORM_REFERRER = DAO_ADDRESSES.treasury;

// Droposal target (the contract used by Gnars droposals on Base)
export const DROPOSAL_TARGET = {
  base: "0x58c3ccb2dcb9384e5ab9111cd1a5dea916b0f33c",
} as const;

// Default mint limit per address for droposals (effectively unlimited)
export const DROPOSAL_DEFAULT_MINT_LIMIT = 1000000 as const;

// /swap — the affiliate fee taken on the bought token when the user keeps the
// "Support Gnars treasury" checkbox checked. Quotes come from SwapsPro, which
// adds this on top of its own 30 bps and pays it out through a 0xSplits
// contract derived from the payout address below. See docs/integrations/swap.md.
export const SWAP_FEE_BPS = 50 as const; // 0.5%

export const SWAP_FEE_RECIPIENT_BASE =
  "0x15E69fD67DcC17E061Ceeb93DaC791e0f5aF0Eae" as `0x${string}`;

/**
 * The SOPA x COINMASTERSGUILD split. Kept as a named address because the
 * treasury pages still attribute historical inflows to it; it is NOT a
 * /swap payout address. It used to be the recipient for every non-Base swap,
 * which meant a checkbox reading "Support Gnars treasury" funded somebody
 * else on four chains out of five. See GNARS_SWAP_PAYOUT below.
 */
export const SWAP_FEE_SPLIT_RECIPIENT =
  "0xa642b91ff941fb68919d1877e9937f3e369dfd68" as `0x${string}`;

/**
 * Where the treasury's cut is paid, per chain — and nowhere else.
 *
 * SwapsPro derives a 0xSplits contract from (payout address, bps) and pays the
 * whole affiliate fee into it, which then divides on-chain between SwapsPro and
 * us. The derivation is deterministic, so both sides compute the same address
 * without registering anything — but the SPLIT and the PAYOUT ADDRESS both
 * have to exist as code on the chain the swap settles on.
 *
 * Measured on 2026-09-03 with eth_getCode: 0x15E69f... holds 89 bytes on Base
 * and ZERO on Ethereum, Arbitrum, BNB Chain, Avalanche and Robinhood Chain.
 * Paying it on those chains would park the money at an address with nothing
 * behind it, so this map has one entry and a chain that is missing from it
 * asks for NO partner fee at all — the user then pays SwapsPro's 30 bps and
 * nothing else, instead of 80 bps of which ours goes nowhere.
 *
 * TO ADD A CHAIN: deploy the same split (same recipients, same shares, same
 * immutable owner) at the same address on that chain — 0xSplits is
 * deterministic, so the address carries over — then add the id here. Robinhood
 * Chain (4663) is the exception: 0xSplits has no factory there yet, so an EOA
 * or a Safe is the only option.
 */
export const GNARS_SWAP_PAYOUT: Readonly<Record<number, `0x${string}`>> = {
  8453: SWAP_FEE_RECIPIENT_BASE,
};

/**
 * The payout address for a chain, or null when the treasury cannot be paid
 * there. Null is a real answer and the caller must not substitute one: an
 * address the treasury does not control is worse than no fee.
 */
export function getSwapFeeRecipient(chainId: number): `0x${string}` | null {
  return GNARS_SWAP_PAYOUT[chainId] ?? null;
}

/** Can the treasury actually be paid on this chain? Drives the fee checkbox. */
export const chainPaysTreasury = (chainId: number): boolean =>
  getSwapFeeRecipient(chainId) !== null;

export const SUBGRAPH = {
  // Official Nouns Builder Subgraph URL for Gnars on Base (Goldsky public)
  url: `https://api.goldsky.com/api/public/${process.env.NEXT_PUBLIC_GOLDSKY_PROJECT_ID || "project_cm33ek8kjx6pz010i2c3w8z25"}/subgraphs/nouns-builder-base-mainnet/latest/gn`,

  // Legacy Gnars subgraph on Ethereum mainnet (The Graph Studio)
  ethMainnet: "https://api.studio.thegraph.com/query/84885/gnars-mainnet/v1.0.0",
} as const;

export const GNARS_ADDRESSES_ETH = {
  token: "0x558bfff0d583416f7c4e380625c7865821b8e95c",
  governor: "0xd10e3dee203579fcee90ed7d0bdd8086f7e53beb",
  treasury: "0x4d3a210f40f83286dc5e4d3fe285dcfef30cce52",
} as const;

export const DAO_DESCRIPTION = "Nounish Open Source Action Sports Brand experiment";

// Token contracts we care about for treasury display
// Provide Base mainnet addresses for known tokens
export const TREASURY_TOKEN_ALLOWLIST = {
  USDC: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  WETH: "0x4200000000000000000000000000000000000006",
  SENDIT: "0xBa5B9B2D2d06a9021EB3190ea5Fb0e02160839A4",
} as const;

export const TREASURY_TOKEN_ADDRESSES = Object.values(TREASURY_TOKEN_ALLOWLIST);

/**
 * /store checkout config. Customers pay USDC on Base to `recipient`; the server verifies that
 * transfer before forwarding the order to the fulfillment provider (KeepKey). `recipient` is
 * the dedicated Gnars store wallet — hardcoded here (public address, safe to commit) with an
 * env override for other deploys. Secrets (KeepKey tokens/webhook) stay in env. USDC on Base
 * has 6 decimals. Sandbox orders skip payment, so this is only used in live mode.
 */
export const STORE_CHECKOUT = {
  usdc: TREASURY_TOKEN_ALLOWLIST.USDC as `0x${string}`,
  usdcDecimals: 6,
  recipient: (process.env.NEXT_PUBLIC_STORE_CHECKOUT_ADDRESS ||
    "0x8Bf5941d27176242745B716251943Ae4892a3C26") as `0x${string}`,
} as const;

/**
 * KeepKey dropship fulfillment mode — the single control for going live.
 *
 * `test` (sandbox) draws no credit and never ships; `live` places real orders that draw the
 * credit line and owe crypto settlement. **To go live, change this to `"live"` and ship it**
 * — it is not read from any env var, so no Vercel change is needed (or possible). Consumed
 * server-side via `isSandbox()`.
 */
export const KEEPKEY_DROPSHIP_MODE: "test" | "live" = "live";

export const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.gnars.com";

/**
 * Base Builder Code — ERC-8021 transaction attribution.
 *
 * `BUILDER_CODE_SUFFIX` is the exact suffix issued by dashboard.base.org for
 * `bc_r8lhotn0`. It is appended to the END of a transaction's calldata, where
 * contracts ignore it (Solidity discards trailing bytes when ABI-decoding), so
 * no contract change is needed on either side. Cost is 16 gas per non-zero byte.
 *
 * The 29 bytes read backwards from the end of the calldata:
 *   8021 x 8   marker
 *   00         version
 *   0b         length of the code (11)
 *   62..30     ASCII "bc_r8lhotn0"
 *
 * Copy the hex verbatim from the dashboard. Never re-derive it from the code
 * string — the framing bytes are theirs to define, not ours to guess.
 */
export const BUILDER_CODE = "bc_r8lhotn0" as const;
export const BUILDER_CODE_SUFFIX =
  "0x62635f72386c686f746e300b0080218021802180218021802180218021" as const;
