import type { Address, Hex } from "viem";

/**
 * KyberSwap aggregator on Base — the migration's SECOND quote source.
 *
 * Probed 2026-09-02 against every public aggregator (LI.FI, 0x, Kyber,
 * OpenOcean, Odos, ParaSwap, Relay, Pioneer): Kyber is the one that routes
 * Zora's Uniswap-v4 hook pools ("uniswap-v4-zora") for content and creator
 * coins, returns plain router calldata (approve + one call, no Permit2
 * signature), allows browser calls from gnars.com, and priced within 1% of
 * Zora's own quote once Zora's post-slippage `amountOut` is corrected for.
 * Executed on a Base fork: delivered within 0.2% of its quote.
 *
 * It is used when Zora's endpoint fails or rate-limits (429s were observed
 * during normal use) or answers "no route", never instead of Zora when Zora
 * answers — Zora's route is marginally better and is the pool's own router.
 */
export const KYBER_API = "https://aggregator-api.kyberswap.com/base/api/v1";
export const KYBER_CLIENT_ID = "gnars.com";
/** Kyber's sentinel for native ETH. */
export const KYBER_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export interface KyberRouteSummary {
  amountIn: string;
  amountOut: string;
  amountOutUsd?: string;
  gasUsd?: string;
  route: { exchange: string; pool: string; tokenIn: string; tokenOut: string }[][];
  [k: string]: unknown;
}

export interface KyberQuote {
  /** Expected ETH out (wei), before slippage. */
  amountOut: bigint;
  routeSummary: KyberRouteSummary;
  /** Exchanges along the path, for display and for logs. */
  exchanges: string[];
}

export interface KyberBuiltCall {
  router: Address;
  data: Hex;
  value: bigint;
  amountOut: bigint;
  /** Router-enforced minimum at the requested slippage. */
  amountOutMin: bigint;
}

const headers = { "content-type": "application/json", "x-client-id": KYBER_CLIENT_ID };

/** Quote selling `amountIn` of `token` for native ETH. `null` = Kyber found no route. */
export async function kyberQuoteToEth(
  token: Address,
  amountIn: bigint,
): Promise<KyberQuote | null> {
  const url = `${KYBER_API}/routes?tokenIn=${token}&tokenOut=${KYBER_NATIVE}&amountIn=${amountIn}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (res.status === 400) return null; // "route not found"
  if (!res.ok) throw new Error(`Kyber routes ${res.status}`);
  const json = (await res.json()) as { data?: { routeSummary?: KyberRouteSummary } };
  const rs = json.data?.routeSummary;
  if (!rs?.amountOut || BigInt(rs.amountOut) <= 0n) return null;
  return {
    amountOut: BigInt(rs.amountOut),
    routeSummary: rs,
    exchanges: Array.from(new Set(rs.route.flat().map((h) => h.exchange))),
  };
}

/** Build the executable router call for a quote at `slippageBps`. */
export async function kyberBuildCall(
  quote: KyberQuote,
  sender: Address,
  slippageBps: number,
): Promise<KyberBuiltCall> {
  const res = await fetch(`${KYBER_API}/route/build`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      routeSummary: quote.routeSummary,
      sender,
      recipient: sender,
      slippageTolerance: slippageBps,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Kyber build ${res.status}`);
  const json = (await res.json()) as {
    data?: { routerAddress?: string; data?: string; transactionValue?: string; amountOut?: string };
  };
  const d = json.data;
  if (!d?.routerAddress || !d.data || !d.amountOut) throw new Error("Kyber build: incomplete");
  const amountOut = BigInt(d.amountOut);
  return {
    router: d.routerAddress as Address,
    data: d.data as Hex,
    value: d.transactionValue ? BigInt(d.transactionValue) : 0n,
    amountOut,
    amountOutMin: (amountOut * BigInt(10_000 - slippageBps)) / 10_000n,
  };
}
