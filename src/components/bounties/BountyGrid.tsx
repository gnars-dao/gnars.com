"use client";

import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { SopaBounty } from "@/lib/poidh-sopa/types";
import type { PoidhBounty } from "@/types/poidh";
import { BountyCard } from "./BountyCard";
import { SopaBountyCard } from "./sopa/SopaBountyCard";

interface BountyGridProps {
  bounties: PoidhBounty[];
  /** PoidhSopa bounties, interleaved with V3 by creation date. */
  sopaBounties?: SopaBounty[];
  isLoading: boolean;
  error: Error | null;
}

type GridItem =
  | { source: "v3"; createdAt: number; bounty: PoidhBounty }
  | { source: "sopa"; createdAt: number; bounty: SopaBounty };

function mergeItems(v3: PoidhBounty[], sopa: SopaBounty[]): GridItem[] {
  if (sopa.length === 0) {
    return v3.map((bounty) => ({ source: "v3", createdAt: bounty.createdAt, bounty }));
  }
  return [
    ...v3.map((bounty) => ({ source: "v3" as const, createdAt: bounty.createdAt, bounty })),
    ...sopa.map((bounty) => ({ source: "sopa" as const, createdAt: bounty.createdAt, bounty })),
  ].sort((a, b) => b.createdAt - a.createdAt);
}

function SkeletonCard() {
  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-5 w-20" />
        </div>
        <Skeleton className="h-5 w-3/4" />
        <div className="space-y-2">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
        </div>
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-3 w-1/3" />
        <div className="flex gap-2 mt-auto">
          <Skeleton className="h-9 flex-1" />
          <Skeleton className="h-9 flex-1" />
        </div>
      </CardContent>
    </Card>
  );
}

export function BountyGrid({ bounties, sopaBounties = [], isLoading, error }: BountyGridProps) {
  const t = useTranslations("bounties");

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-16">
        <p className="text-destructive font-medium mb-1">{t("grid.error")}</p>
        <p className="text-sm text-muted-foreground">{error.message}</p>
      </div>
    );
  }

  const items = mergeItems(bounties, sopaBounties);

  if (items.length === 0) {
    return <div className="text-center py-16 text-muted-foreground">{t("grid.empty")}</div>;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
      {items.map((item) =>
        item.source === "sopa" ? (
          <SopaBountyCard key={`sopa-${item.bounty.id}`} bounty={item.bounty} />
        ) : (
          <BountyCard key={item.bounty.id} bounty={item.bounty} />
        ),
      )}
    </div>
  );
}

export function BountyGridSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
      {Array.from({ length: 6 }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}
