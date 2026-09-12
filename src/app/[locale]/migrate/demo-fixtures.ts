/**
 * Seeded holdings for the campaign demo recording.
 *
 * A recording driven by a real wallet would put that wallet's actual coins,
 * balances, dollar values and profile art into a public video for good — and
 * every take would differ as prices move. This fixture makes the take
 * deterministic and puts nothing real on screen.
 *
 * Gated on IS_DEV by `isDemoMode()`, so it folds away in a production build.
 */
import type { Address } from "viem";
import type { CoinQuote, MigratableCoin } from "@/hooks/use-gnars-migration";
import { IS_DEV } from "@/lib/config";

/** `?demo=1` in development. Never true in a production build. */
export function isDemoMode(): boolean {
  if (!IS_DEV || typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("demo") === "1";
}

export const DEMO_ADDRESS = "0xD3M0000000000000000000000000000000000001" as Address;
/** 0.0412 ETH — enough for the wallet row to read as a real balance. */
export const DEMO_WALLET_WEI = 41_200_000_000_000_000n;

/** Flat geometric marks: recognisable apart, and nobody's real artwork. */
function art(bg: string, fg: string, shape: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" fill="${bg}"/>${shape.replace(/FG/g, fg)}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const SEED: {
  sym: string;
  name: string;
  balance: string;
  eth: bigint;
  usd: number;
  logo: string;
}[] = [
  {
    sym: "DRP",
    name: "Dropin",
    balance: "29885826815800000000000000",
    eth: 3_700_000_000_000_000n,
    usd: 14.02,
    logo: art("#f59e0b", "#1c1917", `<circle cx="32" cy="32" r="16" fill="FG"/>`),
  },
  {
    sym: "SKD",
    name: "Skate or Dice",
    balance: "38457892300900000000000000",
    eth: 2_400_000_000_000_000n,
    usd: 9.1,
    logo: art("#4ade80", "#052e16", `<rect x="16" y="16" width="32" height="32" fill="FG"/>`),
  },
  {
    sym: "MDL",
    name: "Manual Pad",
    balance: "4003509929400000000000000",
    eth: 1_100_000_000_000_000n,
    usd: 3.54,
    logo: art("#38bdf8", "#082f49", `<polygon points="32,14 50,50 14,50" fill="FG"/>`),
  },
  {
    sym: "GHJ",
    name: "Ghost Jump",
    balance: "437533311900000000000000",
    eth: 1_000_000_000_000_000n,
    usd: 2.47,
    logo: art(
      "#a78bfa",
      "#2e1065",
      `<circle cx="32" cy="32" r="18" fill="none" stroke="FG" stroke-width="8"/>`,
    ),
  },
  {
    sym: "UNF",
    name: "Unified Field",
    balance: "1077114798500000000000000",
    eth: 1_000_000_000_000_000n,
    usd: 2.47,
    logo: art("#fb7185", "#4c0519", `<rect x="14" y="26" width="36" height="12" fill="FG"/>`),
  },
  {
    sym: "GNW",
    name: "Gnarly News",
    balance: "1069473100800000000000000",
    eth: 900_000_000_000_000n,
    usd: 2.45,
    logo: art(
      "#facc15",
      "#422006",
      `<polygon points="32,12 40,28 56,32 40,36 32,52 24,36 8,32 24,28" fill="FG"/>`,
    ),
  },
  {
    sym: "SKH",
    name: "Skatehacker",
    balance: "141153952300000000000000",
    eth: 700_000_000_000_000n,
    usd: 1.92,
    logo: art(
      "#34d399",
      "#022c22",
      `<rect x="14" y="14" width="16" height="16" fill="FG"/><rect x="34" y="34" width="16" height="16" fill="FG"/>`,
    ),
  },
  {
    sym: "GRC",
    name: "Grind Club",
    balance: "96540770000000000000000",
    eth: 600_000_000_000_000n,
    usd: 1.58,
    logo: art(
      "#fb923c",
      "#431407",
      `<circle cx="24" cy="32" r="10" fill="FG"/><circle cx="42" cy="32" r="10" fill="FG"/>`,
    ),
  },
];

export const DEMO_COINS: MigratableCoin[] = SEED.map((s, i) => ({
  // Deterministic, obviously-fake addresses: nothing here resolves on-chain.
  address: `0xDEM0${String(i).padStart(2, "0")}${"0".repeat(30)}` as Address,
  symbol: s.sym,
  name: s.name,
  decimals: 18,
  balance: s.balance,
  displayBalance: (Number(BigInt(s.balance) / 10n ** 12n) / 1e6).toString(),
  logoUrl: s.logo,
  usdValue: s.usd,
  marketCap: null,
  pairedWith: null,
  // The demo shows the curated list; the wallet-scan source has its own copy
  // and its own warning, and mixing them would muddy what the video explains.
  source: "zora" as const,
}));

export const DEMO_QUOTES: CoinQuote[] = DEMO_COINS.map((c, i) => ({
  address: c.address,
  provider: "zora" as const,
  status: "routable" as const,
  routable: true,
  out: SEED[i].eth,
  outUsd: SEED[i].usd,
}));
