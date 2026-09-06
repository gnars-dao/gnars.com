"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DAO_ADDRESSES } from "@/lib/config";
import { subgraphQuery } from "@/lib/subgraph";

const AUCTION_BIDS_QUERY = `
  query GetAuctionBids($auctionId: String!) {
    auctionBids(
      where: { auction: $auctionId }
      orderBy: bidTime
      orderDirection: desc
      first: 100
    ) {
      id
      bidder
      amount
      bidTime
      transactionHash
    }
  }
`;

export interface AuctionBid {
  id: string;
  bidder: string;
  amount: string;
  bidTime: string;
  transactionHash: string;
}

const NO_BIDS: AuctionBid[] = [];
const NO_HIGHLIGHTS = new Set<string>();

export function useAuctionBids(
  tokenId: string | undefined,
  enabled: boolean,
  pollIntervalMs = 10_000,
) {
  const query = useQuery({
    queryKey: ["auction-bids", DAO_ADDRESSES.token, tokenId],
    queryFn: async ({ signal }) => {
      const data = await subgraphQuery<{ auctionBids: AuctionBid[] }>(
        AUCTION_BIDS_QUERY,
        { auctionId: `${DAO_ADDRESSES.token}:${tokenId}` },
        { signal },
      );
      return data.auctionBids ?? NO_BIDS;
    },
    enabled: enabled && !!tokenId,
    staleTime: pollIntervalMs,
    refetchInterval: enabled ? pollIntervalMs : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    // The shared subgraph gate already retries transient failures.
    retry: false,
  });
  const bids = query.data ?? NO_BIDS;
  const previous = useRef<{ tokenId: string; ids: Set<string> } | null>(null);
  const [highlight, setHighlight] = useState<{ tokenId: string; ids: Set<string> } | null>(null);

  useEffect(() => {
    if (!tokenId || !query.data) return;
    const ids = new Set(query.data.map((bid) => bid.id));
    const incoming =
      previous.current?.tokenId === tokenId
        ? new Set([...ids].filter((id) => !previous.current!.ids.has(id)))
        : NO_HIGHLIGHTS;
    previous.current = { tokenId, ids };
    setHighlight({ tokenId, ids: incoming });
    if (!incoming.size) return;
    const timer = setTimeout(() => setHighlight(null), 3000);
    return () => clearTimeout(timer);
  }, [tokenId, query.data]);

  return {
    bids,
    isLoading: query.isLoading,
    error: query.error?.message ?? null,
    newBidIds: highlight && highlight.tokenId === tokenId ? highlight.ids : NO_HIGHLIGHTS,
  };
}
