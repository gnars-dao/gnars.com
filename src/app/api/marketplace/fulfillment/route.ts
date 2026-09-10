import { corsPreflight, withCors } from "@/lib/server/cors";
import { enforceRateLimit, readJsonBody } from "@/lib/server/request-security";
import { marketplaceErrorResponse, parseMarketplaceInput } from "@/services/marketplace-common";
import {
  marketplaceFulfillmentSchema,
  prepareMarketplaceFulfillment,
} from "@/services/marketplace-fulfillment";
import { enforceMarketplaceBudget } from "@/services/marketplace-orders";

export const dynamic = "force-dynamic";
export const POST = withCors(async (request: Request) => {
  try {
    await enforceRateLimit(request, {
      scope: "marketplace-fulfillment",
      limit: 20,
      windowSeconds: 60,
    });
    const input = parseMarketplaceInput(
      marketplaceFulfillmentSchema,
      await readJsonBody(request, 2048),
    );
    if (input.source === "gnars") await enforceMarketplaceBudget(request, "fulfillment");
    return Response.json(await prepareMarketplaceFulfillment(input), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
});

export const OPTIONS = (request: Request) => corsPreflight(request, ["POST", "OPTIONS"]);
