import { revalidateTag } from "next/cache";
import { z } from "zod";
import { enforceRateLimit, readJsonBody } from "@/lib/server/request-security";
import {
  marketplaceErrorResponse,
  marketplaceHashSchema,
  parseMarketplaceInput,
} from "@/services/marketplace-common";
import { COMMUNITY_CACHE_TAG, reconcileCommunityOrder } from "@/services/marketplace-community";
import { enforceMarketplaceBudget } from "@/services/marketplace-orders";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, { scope: "community-reconcile", limit: 10, windowSeconds: 60 });
    const { orderHash } = parseMarketplaceInput(
      z.object({ orderHash: marketplaceHashSchema }).strict(),
      await readJsonBody(request, 1024),
    );
    await enforceMarketplaceBudget(request, "reconcile");
    const result = await reconcileCommunityOrder(orderHash);
    revalidateTag(COMMUNITY_CACHE_TAG, { expire: 0 });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}
