import { enforceRateLimit } from "@/lib/server/request-security";
import { getMarketplaceCombinedActivity } from "@/services/marketplace-combined-activity";
import { marketplaceErrorResponse } from "@/services/marketplace-common";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await enforceRateLimit(request, {
      scope: "marketplace-activity",
      limit: 30,
      windowSeconds: 60,
    });
    const page = await getMarketplaceCombinedActivity(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    return Response.json(page, {
      headers: {
        "Cache-Control":
          page.sources.opensea.available && page.sources.gnars.available
            ? "public, s-maxage=30, stale-while-revalidate=30"
            : "no-store",
      },
    });
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}
