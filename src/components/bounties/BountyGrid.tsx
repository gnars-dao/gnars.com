"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
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
  /** Placeholder cards while loading. */
  skeletonCount?: number;
  /** Offered on the empty state when filters are what emptied the grid. */
  onReset?: () => void;
  /**
   * Cards rendered up front; the rest wait behind "Show more", so a phone does not lay
   * out a hundred cards in one column. Remount (change `key`) to start over.
   */
  pageSize?: number;
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

export function BountyGrid({
  bounties,
  sopaBounties = [],
  isLoading,
  error,
  skeletonCount = 6,
  onReset,
  pageSize = 12,
}: BountyGridProps) {
  const t = useTranslations("bounties");
  const [visible, setVisible] = useState(pageSize);

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {Array.from({ length: skeletonCount }).map((_, i) => (
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
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
        <p>{t("grid.empty")}</p>
        {onReset && (
          <Button variant="outline" size="sm" onClick={onReset}>
            {t("filters.reset")}
          </Button>
        )}
      </div>
    );
  }

  const hidden = items.length - visible;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {items
          .slice(0, visible)
          .map((item) =>
            item.source === "sopa" ? (
              <SopaBountyCard key={`sopa-${item.bounty.id}`} bounty={item.bounty} />
            ) : (
              <BountyCard key={`${item.bounty.chainId}-${item.bounty.id}`} bounty={item.bounty} />
            ),
          )}
      </div>
      {hidden > 0 && (
        <Button
          variant="outline"
          className="h-11 w-full sm:mx-auto sm:flex sm:w-auto sm:px-8"
          onClick={() => setVisible((v) => v + pageSize)}
        >
          {t("grid.showMore", { count: hidden })}
        </Button>
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
