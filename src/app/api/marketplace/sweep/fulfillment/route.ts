import { enforceRateLimit, readJsonBody } from "@/lib/server/request-security";
import { marketplaceErrorResponse, parseMarketplaceInput } from "@/services/marketplace-common";
import { enforceMarketplaceBudget } from "@/services/marketplace-orders";
import { prepareMarketplaceSweep, sweepFulfillmentSchema } from "@/services/marketplace-sweep";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, {
      scope: "marketplace-sweep-fulfillment",
      limit: 10,
      windowSeconds: 60,
    });
    const input = parseMarketplaceInput(sweepFulfillmentSchema, await readJsonBody(request, 8192));
    await enforceMarketplaceBudget(request, "fulfillment");
    return Response.json(await prepareMarketplaceSweep(input), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}
