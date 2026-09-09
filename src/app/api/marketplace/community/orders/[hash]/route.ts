import { enforceRateLimit } from "@/lib/server/request-security";
import {
  marketplaceErrorResponse,
  marketplaceHashSchema,
  parseMarketplaceInput,
} from "@/services/marketplace-common";
import { getCommunityOrder } from "@/services/marketplace-community";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ hash: string }> }) {
  try {
    await enforceRateLimit(request, { scope: "community-read", limit: 60, windowSeconds: 60 });
    const hash = parseMarketplaceInput(marketplaceHashSchema, (await context.params).hash);
    const { listing, feePolicy } = await getCommunityOrder(hash);
    return Response.json({ listing, feePolicy }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}
