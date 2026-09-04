import { formatUnits, parseUnits } from "viem";

/**
 * SwapsPro quotes, in the shape the swap widget already reads.
 *
 * The widget was written against 0x's allowance-holder responses
 * (`liquidityAvailable`, `buyAmount` in base units, `issues.allowance.spender`,
 * `transaction { to, data, value, gas }`). SwapsPro's `/quote` answers with one
 * routed quote across 0x, CoW, LI.FI, Relay and more — no API key — but in
 * human decimals and with its own field names. This module is the translation,
 * kept pure so it can be unit-tested without a network.
 *
 * https://www.swaps.pro/docs/api/quote
 */

export const SWAPPRO_BASE_URL = "https://www.swaps.pro/api/sdk/v1";

/** 0x's convention for the native asset, which the widget's token list uses. */
export const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

/** Chains SwapsPro routes, keyed by EIP-155 id, with the symbol its native asset resolves under. */
export const SWAPPRO_CHAINS: Record<number, { id: string; native: string }> = {
  1: { id: "ETH", native: "ETH" },
  8453: { id: "BASE", native: "ETH" },
  42161: { id: "ARB", native: "ETH" },
  56: { id: "BSC", native: "BNB" },
  43114: { id: "AVAX", native: "AVAX" },
  4663: { id: "RHD", native: "ETH" },
};

export interface SwapProQuote {
  provider: string;
  sellChain: string;
  buyChain: string;
  sellToken: { caip: string; symbol: string };
  buyToken: { caip: string; symbol: string };
  /** Human decimals, e.g. "0.1". */
  sellAmount: string;
  buyAmount: string;
  minBuyAmount?: string;
  rate: number;
  tx?: { chainId: number; to: string; data?: string; value?: string; gasLimit?: string };
  approval?: { chainId: number; token: string; spender: string; amountWei: string };
  expiresAt: string;
  partner?: string;
  partnerFeeBps?: number;
  partnerFee?: {
    requestedBps: number;
    collectedBps: number;
    collected: boolean;
    paidToPartner?: boolean;
    note: string;
  };
}

/**
 * SwapsPro's error body, in BOTH shapes it can arrive in.
 *
 * v1 answered `{ error: "…", code: "…" }` with the message as a plain string.
 * The standard shape being rolled out answers
 * `{ error: { code, message, retryable }, message: "…" }`, keeping the
 * top-level `message` for one release. Reading `error` as a string against the
 * new body would print "[object Object]" on the screen and nothing would throw,
 * so both are read and `reasonOf` decides.
 */
export interface SwapProError {
  error: string | { code?: string; message?: string; retryable?: boolean };
  /** The transitional top-level message on the new shape. */
  message?: string;
  code?: string;
}

/** The sentence to show, whichever error shape came back. */
export function reasonOf(e: SwapProError): string {
  if (typeof e.error === "string" && e.error) return e.error;
  if (e.error && typeof e.error === "object" && e.error.message) return e.error.message;
  return e.message ?? "SwapsPro did not say why";
}

/** The machine-readable code, whichever error shape came back. */
export function codeOf(e: SwapProError): string {
  if (e.error && typeof e.error === "object" && e.error.code) return e.error.code;
  return e.code ?? "UPSTREAM_UNAVAILABLE";
}

/** What the widget reads. Superset of the 0x fields it touches. */
export interface WidgetQuote {
  liquidityAvailable: boolean;
  sellAmount?: string;
  buyAmount?: string;
  minBuyAmount?: string;
  issues?: {
    allowance?: { spender: string; amount: string } | null;
    balance?: null;
  };
  transaction?: { to: string; data: string; value: string; gas?: string };
  /** Which venue SwapsPro chose: 0x, cow, lifi, relay, … */
  route?: string;
  /** SwapsPro's own accounting of the affiliate fee, verbatim. */
  partnerFee?: SwapProQuote["partnerFee"];
  expiresAt?: string;
  reason?: string;
  code?: string;
}

export interface QuoteRequest {
  chainId: number;
  /** Token address, or the native sentinel. */
  sellToken: string;
  buyToken: string;
  /** Base units, as the widget sends them. */
  sellAmount: string;
  sellDecimals: number;
  buyDecimals: number;
  taker: string;
  /** Affiliate fee opt-in: the recipient address and the bps. */
  fee?: { recipient: string; bps: number } | null;
}

/** The SwapsPro token parameter for a widget token: symbol for the native asset, address otherwise. */
export function toSwapProToken(chainId: number, token: string): string | null {
  const chain = SWAPPRO_CHAINS[chainId];
  if (!chain) return null;
  return token.toLowerCase() === NATIVE_SENTINEL ? chain.native : token;
}

/** The query string for SwapsPro's /quote. Null when the chain is not one SwapsPro routes. */
export function buildQuoteUrl(req: QuoteRequest, base: string = SWAPPRO_BASE_URL): string | null {
  const chain = SWAPPRO_CHAINS[req.chainId];
  const sell = toSwapProToken(req.chainId, req.sellToken);
  const buy = toSwapProToken(req.chainId, req.buyToken);
  if (!chain || !sell || !buy) return null;
  const params = new URLSearchParams({
    sellChain: String(req.chainId),
    sellToken: sell,
    buyChain: String(req.chainId),
    buyToken: buy,
    amount: formatUnits(BigInt(req.sellAmount), req.sellDecimals),
    address: req.taker,
    partner: req.fee?.recipient ?? "gnars",
  });
  if (req.fee && req.fee.bps > 0) params.set("partnerFeeBps", String(req.fee.bps));
  return `${base}/quote?${params.toString()}`;
}

const toBaseUnits = (human: string | undefined, decimals: number): string | undefined => {
  if (human == null) return undefined;
  try {
    return parseUnits(human, decimals).toString();
  } catch {
    return undefined;
  }
};

const toDecimalString = (hexOrDec: string | undefined): string => {
  if (!hexOrDec) return "0";
  try {
    return BigInt(hexOrDec).toString();
  } catch {
    return "0";
  }
};

/** A SwapsPro quote in the widget's shape. */
export function toWidgetQuote(
  q: SwapProQuote,
  sellDecimals: number,
  buyDecimals: number,
): WidgetQuote {
  return {
    liquidityAvailable: true,
    sellAmount: toBaseUnits(q.sellAmount, sellDecimals),
    buyAmount: toBaseUnits(q.buyAmount, buyDecimals),
    minBuyAmount: toBaseUnits(q.minBuyAmount, buyDecimals),
    issues: {
      allowance: q.approval ? { spender: q.approval.spender, amount: q.approval.amountWei } : null,
      balance: null,
    },
    transaction: q.tx?.data
      ? {
          to: q.tx.to,
          data: q.tx.data,
          value: toDecimalString(q.tx.value),
          gas: q.tx.gasLimit ? toDecimalString(q.tx.gasLimit) : undefined,
        }
      : undefined,
    route: q.provider,
    partnerFee: q.partnerFee,
    expiresAt: q.expiresAt,
  };
}

/** A SwapsPro error in the widget's shape: no liquidity, with the reason it gave. */
export function toWidgetError(e: SwapProError): WidgetQuote {
  return { liquidityAvailable: false, reason: reasonOf(e), code: codeOf(e) };
}

/** One call to SwapsPro, translated. Never throws on an API answer; throws only when there is none. */
export async function fetchWidgetQuote(
  req: QuoteRequest,
  base: string = SWAPPRO_BASE_URL,
): Promise<{ status: number; body: WidgetQuote }> {
  const url = buildQuoteUrl(req, base);
  if (!url) {
    return {
      status: 400,
      body: {
        liquidityAvailable: false,
        reason: `SwapsPro does not route chain ${req.chainId} yet`,
        code: "UNSUPPORTED_CHAIN",
      },
    };
  }
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(45_000),
  });
  const data = (await res.json()) as SwapProQuote | SwapProError;
  if (!res.ok || "error" in data) {
    // A NO_ROUTE answer is a quote result, not a failure: the widget shows "no liquidity".
    return {
      status: res.status === 502 ? 200 : res.status,
      body: toWidgetError(data as SwapProError),
    };
  }
  return { status: 200, body: toWidgetQuote(data, req.sellDecimals, req.buyDecimals) };
}
