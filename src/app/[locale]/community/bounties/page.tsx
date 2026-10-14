import { Suspense } from "react";
import { BountiesView } from "@/components/bounties/BountiesView";
import { BountyGridSkeleton } from "@/components/bounties/BountyGrid";
import { isPoidhSopaEnabled } from "@/lib/config";
import type { SopaBountiesResult } from "@/lib/poidh-sopa/types";
import { fetchPoidhBounties } from "@/services/poidh";
import { fetchSopaBounties } from "@/services/poidh-sopa";
import type { PoidhBounty } from "@/types/poidh";

export const revalidate = 300;

export default async function BountiesPage() {
  const [v3, sopa] = await Promise.all([
    fetchPoidhBounties({ status: "open" }).catch(() => null),
    isPoidhSopaEnabled() ? fetchSopaBounties() : Promise.resolve(undefined),
  ]);
  // POIDH API down — render empty, client will retry
  const bounties: PoidhBounty[] = v3?.bounties ?? [];
  // A partial Sopa read must not be baked into the ISR page; the client refetches it.
  const initialSopa: SopaBountiesResult | undefined = sopa?.partial ? undefined : sopa;

  return (
    <Suspense fallback={<BountyGridSkeleton />}>
      <BountiesView initialBounties={bounties} initialSopa={initialSopa} />
    </Suspense>
  );
}
