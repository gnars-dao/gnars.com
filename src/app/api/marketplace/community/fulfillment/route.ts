import { enforceRateLimit, readJsonBody } from "@/lib/server/request-security";
import { marketplaceErrorResponse, parseMarketplaceInput } from "@/services/marketplace-common";
import {
  communityFulfillmentSchema,
  prepareCommunityFulfillment,
} from "@/services/marketplace-community";
import { enforceMarketplaceBudget } from "@/services/marketplace-orders";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, {
      scope: "community-fulfillment",
      limit: 20,
      windowSeconds: 60,
    });
    const input = parseMarketplaceInput(
      communityFulfillmentSchema,
      await readJsonBody(request, 2048),
    );
    await enforceMarketplaceBudget(request, "fulfillment");
    return Response.json(await prepareCommunityFulfillment(input), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}
