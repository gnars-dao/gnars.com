import { enforceRateLimit } from "@/lib/server/request-security";
import { loadMarketplaceToken } from "@/services/marketplace";
import {
  marketplaceErrorResponse,
  marketplaceUintSchema,
  parseMarketplaceInput,
} from "@/services/marketplace-common";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ tokenId: string }> }) {
  try {
    await enforceRateLimit(request, { scope: "marketplace-detail", limit: 30, windowSeconds: 60 });
    const tokenId = parseMarketplaceInput(marketplaceUintSchema, (await context.params).tokenId);
    const page = await loadMarketplaceToken(tokenId);
    return Response.json(page, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}
