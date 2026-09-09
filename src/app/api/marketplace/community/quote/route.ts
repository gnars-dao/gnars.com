import { enforceRateLimit, readJsonBody } from "@/lib/server/request-security";
import { marketplaceErrorResponse, parseMarketplaceInput } from "@/services/marketplace-common";
import { communityQuoteSchema, quoteCommunityListing } from "@/services/marketplace-community";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, { scope: "community-quote", limit: 30, windowSeconds: 60 });
    const input = parseMarketplaceInput(communityQuoteSchema, await readJsonBody(request, 2048));
    return Response.json(
      { quote: await quoteCommunityListing(input) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}
