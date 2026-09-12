/**
 * Second holdings source for /migrate: plain Base ERC-20 tokens the connected
 * wallet holds, which Zora's indexer does not know about.
 *
 * Balances and metadata come from the existing Alchemy route
 * (`/api/wallet/tokens` — `alchemy_getTokenBalances` + `alchemy_getTokenMetadata`,
 * plus CoinGecko prices), so there is exactly one Alchemy client in the repo.
 *
 * The catch: a raw balance scan of a real Base wallet is mostly airdropped
 * scam, and some of it is engineered to look valuable. A live scan of the Gnars
 * treasury returned 69 tokens, of which 3 had a price and roughly a dozen
 * carried a phishing URL in their own symbol ("Claim: toshi-thecat.com/?claim").
 * Everything below is the first, metadata-only half of the filter that earns
 * back the page's safety promise; the second half lives at the quote layer,
 * where a token must have a real KyberSwap route to ETH worth at least
 * MIN_WALLET_TOKEN_USD before it is ever rendered.
 */
import { isAddress } from "viem";
import type { WalletToken } from "@/app/[locale]/swap/chains";

/**
 * Minimum ETH-value, in USD, a wallet token's full balance must quote for
 * before it is shown. Below roughly a dollar the approve + swap on Base is a
 * meaningful fraction of the proceeds and the row is pure noise, so this is the
 * point where listing it stops being a favour to the user.
 */
export const MIN_WALLET_TOKEN_USD = 1;

/**
 * Fallback floor in wei for the rare quote that carries no USD figure: ~0.0003
 * ETH, which is about a dollar across the ETH price range this page has run in.
 * A missing price must never mean "let it through".
 */
export const MIN_WALLET_TOKEN_WEI = 300_000_000_000_000n;

/** Above this many whole units a balance is an airdrop, not a holding. */
export const MAX_PLAUSIBLE_TOKEN_UNITS = 1e15;

/** ERC-20 decimals beyond this are outside anything real and break formatting. */
export const MAX_TOKEN_DECIMALS = 24;

const MAX_SYMBOL_LENGTH = 16;
const MAX_NAME_LENGTH = 40;

/**
 * Text that only ever appears in airdrop spam. Scam tokens have to tell the
 * victim where to go, and the only field they control is their own name — so
 * the instructions land in the symbol or the name and are trivially greppable.
 */
const SPAM_TEXT_PATTERNS: RegExp[] = [
  /https?:\/\//i,
  /\bwww\./i,
  /\bt\.me\b/i,
  // A bare domain anywhere in the name (degen.gifts, baseusdc.org, USD.AC, t.ly).
  /[a-z0-9-]{2,}\.(com|net|org|io|xyz|cash|gifts|app|link|site|top|club|finance|fi|ac|ly|me|pro|vip|info|live|shop|store|co)\b/i,
  /\b(airdrop|claim|redeem|reward|rewards|voucher|giveaway|bonus|visit|collect|distribution|earn)\b/i,
];

/** True when either label is made of characters a real Base token does not use. */
function hasUnprintableLabel(...labels: string[]): boolean {
  // Anything outside printable ASCII: emoji padding and Cyrillic homoglyphs
  // ("✅СIRCLE", where the C is U+0421) are both spam tells and both caught here.
  return labels.some((label) => /[^\x20-\x7E]/.test(label));
}

/** True when either label reads like a phishing instruction rather than a name. */
export function hasSpamLabel(symbol: string, name: string): boolean {
  if (hasUnprintableLabel(symbol, name)) return true;
  return SPAM_TEXT_PATTERNS.some((re) => re.test(symbol) || re.test(name));
}

/**
 * Metadata-only half of the spam filter. Deliberately cheap and total: it runs
 * before any quote is paid for, and everything it lets through still has to
 * earn a real route to ETH.
 */
export function isPlausibleWalletToken(token: WalletToken): boolean {
  if (!isAddress(token.address)) return false;

  const symbol = token.symbol?.trim() ?? "";
  const name = token.name?.trim() ?? "";
  // Missing metadata is itself a signal: a token nobody bothered to name.
  if (symbol === "" || name === "") return false;
  if (symbol.length > MAX_SYMBOL_LENGTH || name.length > MAX_NAME_LENGTH) return false;
  if (hasSpamLabel(symbol, name)) return false;

  if (!Number.isInteger(token.decimals) || token.decimals < 0) return false;
  if (token.decimals > MAX_TOKEN_DECIMALS) return false;

  let balance: bigint;
  try {
    balance = BigInt(token.balance);
  } catch {
    return false;
  }
  if (balance <= 0n) return false;

  const units = Number(token.displayBalance);
  if (!Number.isFinite(units) || units <= 0) return false;
  if (units > MAX_PLAUSIBLE_TOKEN_UNITS) return false;

  // A known price below the floor is a decision, not a guess — drop it now and
  // save the quote. An unknown price proves nothing and is left to the router.
  if (token.usdValue !== null && token.usdValue < MIN_WALLET_TOKEN_USD) return false;

  return true;
}

/**
 * Every plain ERC-20 the wallet holds on Base that survives the metadata
 * filter. Client-side: the route is same-origin and holds the Alchemy key.
 *
 * Throws on a failed read so the caller can render a failure. A wallet scan
 * that fell over must never render as "you hold nothing".
 */
export async function fetchWalletBaseTokens(
  address: string,
  options: { chainId?: number; signal?: AbortSignal } = {},
): Promise<WalletToken[]> {
  const { chainId = 8453, signal } = options;
  const res = await fetch(
    `/api/wallet/tokens?address=${address}&chainId=${chainId}`,
    signal ? { signal } : {},
  );
  if (!res.ok) throw new Error(`Wallet token scan failed (${res.status})`);
  const tokens = (await res.json()) as WalletToken[];
  if (!Array.isArray(tokens)) throw new Error("Wallet token scan returned an unexpected shape");
  return tokens.filter(isPlausibleWalletToken);
}
