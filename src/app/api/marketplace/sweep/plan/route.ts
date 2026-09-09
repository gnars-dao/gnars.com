import { enforceRateLimit, readJsonBody } from "@/lib/server/request-security";
import { marketplaceErrorResponse, parseMarketplaceInput } from "@/services/marketplace-common";
import {
  mixedSweepQuoteSchema,
  quoteMixedMarketplaceSweep,
} from "@/services/marketplace-mixed-sweep";
import { enforceMarketplaceBudget } from "@/services/marketplace-orders";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, {
      scope: "marketplace-sweep-quote",
      limit: 10,
      windowSeconds: 60,
    });
    const input = parseMarketplaceInput(mixedSweepQuoteSchema, await readJsonBody(request, 8192));
    await enforceMarketplaceBudget(request, "reconcile");
    return Response.json(await quoteMixedMarketplaceSweep(input), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}
