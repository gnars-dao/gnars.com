"use client";

import { useQuery } from "@tanstack/react-query";
import { isPoidhSopaEnabled } from "@/lib/config";
import type { SopaBountiesResult, SopaBountyDetail } from "@/lib/poidh-sopa/types";

export const sopaBountiesKey = ["poidh-sopa-bounties"] as const;
export const sopaBountyKey = (id: number) => ["poidh-sopa-bounty", id] as const;

/** All Sopa bounties (newest first). Disabled when Sopa is not configured. */
export function usePoidhSopaBounties(initialData?: SopaBountiesResult) {
  return useQuery<SopaBountiesResult, Error>({
    queryKey: sopaBountiesKey,
    enabled: isPoidhSopaEnabled(),
    queryFn: async () => {
      const res = await fetch("/api/poidh/sopa/bounties");
      const body = (await res.json()) as SopaBountiesResult & { error?: string };
      if (!res.ok) throw new Error(body.error || "Failed to load Sopa bounties");
      return body;
    },
    // A server-side read failure arrives as `error`; let the client retry right away.
    initialData:
      initialData && !initialData.error && !initialData.partial ? initialData : undefined,
    staleTime: 60_000,
  });
}

export function usePoidhSopaBounty(id: number, initialData?: SopaBountyDetail) {
  return useQuery<SopaBountyDetail, Error>({
    queryKey: sopaBountyKey(id),
    queryFn: async () => {
      const res = await fetch(`/api/poidh/sopa/bounty/${id}`);
      const body = (await res.json()) as { bounty?: SopaBountyDetail; error?: string };
      if (!res.ok || !body.bounty) throw new Error(body.error || "Failed to load bounty");
      return body.bounty;
    },
    initialData,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}
