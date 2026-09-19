import { enforceRateLimit } from "@/lib/server/request-security";
import { getMarketplaceActivity } from "@/services/marketplace-activity";
import { marketplaceErrorResponse } from "@/services/marketplace-common";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await enforceRateLimit(request, {
      scope: "marketplace-activity",
      limit: 30,
      windowSeconds: 60,
    });
    const page = await getMarketplaceActivity(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    return Response.json(page, {
      headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=30" },
    });
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}
