"use client";

/**
 * The connected wallet's old $gnars (the Zora creator coin) and what selling
 * a chosen amount of it to ETH would return.
 *
 * ETH-only means an existing holder can only enter the migration by selling
 * into the thin $gnars → ZORA → WETH pool. This hook quotes that sale before
 * anyone commits and puts a number on the price impact (see
 * `src/lib/price-impact.ts`). Holding and doing nothing is the other option;
 * the UI says so.
 *
 * The balance is read with wagmi. A failed read is an error, never a zero.
 *
 * `sellAmount` is the portion the holder chose to sell; it defaults to the whole
 * balance. The quote AND the price impact both follow it, because impact is a
 * function of size: quoting the full balance while selling a tenth of it would
 * show a scary number that the actual sale never pays.
 */
import { useQuery } from "@tanstack/react-query";
import { createTradeCall, type TradeParameters } from "@zoralabs/coins-sdk";
import { erc20Abi, type Address } from "viem";
import { useReadContract } from "wagmi";
import { MIGRATION_SLIPPAGE } from "@/hooks/use-gnars-migration";
import { CHAIN, GNARS_CREATOR_COIN } from "@/lib/config";
import { priceImpactBps, referenceSlice } from "@/lib/price-impact";
import { expectedFromZoraQuote } from "@/lib/route-margin";

export interface OldGnarsQuote {
  /** ETH (wei) for selling `sellAmount`. */
  out: bigint;
  /** Price impact vs. the marginal price, in bps; null when it could not be derived. */
  impactBps: number | null;
}

export function useOldGnarsPosition(
  address: string | undefined,
  sellAmount?: bigint,
  slippage = MIGRATION_SLIPPAGE,
) {
  const balanceRead = useReadContract({
    address: GNARS_CREATOR_COIN,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [(address ?? "0x0000000000000000000000000000000000000000") as Address],
    chainId: CHAIN.id,
    query: { enabled: Boolean(address), staleTime: 30_000 },
  });
  const balance = balanceRead.data;
  // A portion above the balance is not sellable; clamp instead of quoting a
  // trade that would revert. No choice yet (or a zero) means the whole balance.
  const amount =
    balance === undefined
      ? undefined
      : sellAmount === undefined || sellAmount <= 0n
        ? balance
        : sellAmount > balance
          ? balance
          : sellAmount;

  const quote = useQuery<OldGnarsQuote>({
    queryKey: ["old-gnars-quote", address?.toLowerCase(), amount?.toString(), slippage],
    enabled: Boolean(address) && amount !== undefined && amount > 0n,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const bal = amount as bigint;
      const sender = address as Address;
      const params = (amountIn: bigint): TradeParameters => ({
        sell: { type: "erc20", address: GNARS_CREATOR_COIN },
        buy: { type: "eth" },
        amountIn,
        slippage,
        sender,
      });
      const ref = referenceSlice(bal);
      const [full, small] = await Promise.all([
        createTradeCall(params(bal)),
        ref === bal ? null : createTradeCall(params(ref)),
      ]);
      if (!full?.success || !full.quote?.amountOut) throw new Error("No route for $gnars → ETH");
      const out = BigInt(full.quote.amountOut);
      const refOut =
        small?.success && small.quote?.amountOut ? BigInt(small.quote.amountOut) : null;
      // Both quotes carry the same slippage, so the impact ratio is unaffected;
      // the displayed amount is the expected one, with the slippage divided out.
      return {
        out: expectedFromZoraQuote(out, slippage),
        impactBps: refOut === null ? null : priceImpactBps(ref, refOut, bal, out),
      };
    },
  });

  return {
    balance,
    /** The amount the quote is for — the clamped `sellAmount`, or the balance. */
    sellAmount: amount,
    isBalanceLoading: balanceRead.isLoading,
    isBalanceError: balanceRead.isError,
    refetchBalance: balanceRead.refetch,
    quote: quote.data,
    isQuoting: quote.isLoading,
    isQuoteError: quote.isError,
  };
}
