import { enforceRateLimit, requestSecurityResponse } from "@/lib/server/request-security";
import { marketplaceHashSchema, parseMarketplaceInput } from "@/services/marketplace-common";
import { getOpenSeaCancellationOrder } from "@/services/marketplace-opensea";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ hash: string }> }) {
  try {
    await enforceRateLimit(request, {
      scope: "marketplace-opensea-order",
      limit: 20,
      windowSeconds: 60,
    });
    const hash = parseMarketplaceInput(marketplaceHashSchema, (await context.params).hash);
    return Response.json(
      { order: await getOpenSeaCancellationOrder(hash) },
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    return requestSecurityResponse(error);
  }
}
