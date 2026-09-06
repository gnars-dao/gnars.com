import { enforceRateLimit, requestSecurityResponse } from "@/lib/server/request-security";
import { getMarketplaceReadiness } from "@/services/marketplace";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    await enforceRateLimit(request, { scope: "marketplace-read", limit: 60, windowSeconds: 60 });
    return Response.json(await getMarketplaceReadiness(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return requestSecurityResponse(error);
  }
}
