import { revalidateTag } from "next/cache";
import { z } from "zod";
import { enforceRateLimit, readJsonBody } from "@/lib/server/request-security";
import { marketplaceErrorResponse, parseMarketplaceInput } from "@/services/marketplace-common";
import { COMMUNITY_CACHE_TAG, publishCommunityOrder } from "@/services/marketplace-community";
import { enforceMarketplaceBudget } from "@/services/marketplace-orders";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, { scope: "community-create", limit: 10, windowSeconds: 60 });
    const { listing } = parseMarketplaceInput(
      z.object({ listing: z.unknown().refine((value) => value !== undefined) }).strict(),
      await readJsonBody(request, 24000),
    );
    await enforceMarketplaceBudget(request, "create");
    const offer = await publishCommunityOrder(listing);
    revalidateTag(COMMUNITY_CACHE_TAG, { expire: 0 });
    return Response.json({ offer }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}
