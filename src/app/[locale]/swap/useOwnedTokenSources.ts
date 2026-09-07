"use client";

import { useQuery } from "@tanstack/react-query";
import { isAddress, zeroAddress } from "viem";
import {
  SWAP_TOKEN_SOURCES_BATCH_SIZE,
  swapTokenSourcesSchema,
  type SwapTokenSource,
  type SwapTokenSources,
} from "@/lib/swap-token-sources";
import { NATIVE_TOKEN, type SwapToken, type WalletToken } from "./chains";
import { tokenKey } from "./tokenPickerModel";

export function useOwnedTokenSources({
  chainId,
  userAddress,
  enabled,
  holdings,
  knownTokens,
  curatedTokens,
}: {
  chainId: number;
  userAddress?: string;
  enabled: boolean;
  holdings: readonly WalletToken[];
  knownTokens: readonly SwapToken[];
  curatedTokens: readonly SwapToken[];
}) {
  const known = new Set([
    ...knownTokens.filter((token) => token.category).map((token) => tokenKey(token.address)),
    ...curatedTokens.map((token) => tokenKey(token.address)),
  ]);
  const addresses = [
    ...new Set(
      holdings
        .filter((token) => Number(token.balance) > 0)
        .map((token) => tokenKey(token.address))
        .filter(
          (address) =>
            isAddress(address) &&
            address !== zeroAddress &&
            address !== NATIVE_TOKEN &&
            !known.has(address),
        ),
    ),
  ].sort();

  return useQuery<SwapTokenSources>({
    queryKey: ["swap-owned-token-sources", chainId, userAddress?.toLowerCase(), addresses],
    enabled: enabled && chainId === 8453 && !!userAddress && addresses.length > 0,
    staleTime: (query) => (query.state.data?.complete === false ? 30_000 : 3_600_000),
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      const tokens: SwapTokenSource[] = [];
      let complete = true;
      // Resolve sequential batches, never one client request per holding or an unbounded fan-out.
      for (let index = 0; index < addresses.length; index += SWAP_TOKEN_SOURCES_BATCH_SIZE) {
        const batch = addresses.slice(index, index + SWAP_TOKEN_SOURCES_BATCH_SIZE);
        try {
          const params = new URLSearchParams({
            chainId: String(chainId),
            addresses: batch.join(","),
          });
          const response = await fetch(`/api/swap/token-sources?${params}`, { signal });
          if (!response.ok) throw new Error("Owned token sources unavailable");
          const data = swapTokenSourcesSchema.parse(await response.json());
          const requested = new Set(batch);
          tokens.push(...data.tokens.filter((token) => requested.has(tokenKey(token.address))));
          if (!data.complete) {
            complete = false;
            break;
          }
        } catch (error) {
          if (signal.aborted) throw error;
          complete = false;
          break;
        }
      }
      return { tokens, complete };
    },
  });
}
