import { enforceRateLimit } from "@/lib/server/request-security";
import {
  marketplaceErrorResponse,
  marketplaceHashSchema,
  parseMarketplaceInput,
} from "@/services/marketplace-common";
import { getMarketplaceOrder } from "@/services/marketplace-orders";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ hash: string }> }) {
  try {
    await enforceRateLimit(request, { scope: "marketplace-read", limit: 60, windowSeconds: 60 });
    const hash = parseMarketplaceInput(marketplaceHashSchema, (await context.params).hash);
    return Response.json(
      { listing: await getMarketplaceOrder(hash) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}
