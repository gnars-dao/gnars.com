import { z } from "zod";
import {
  enforceRateLimit,
  readJsonBody,
  requestSecurityResponse,
} from "@/lib/server/request-security";
import { parseMarketplaceInput } from "@/services/marketplace-common";
import {
  invalidateOpenSeaOrdersCache,
  publishOpenSeaListing,
} from "@/services/marketplace-opensea";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, {
      scope: "marketplace-opensea-post",
      limit: 10,
      windowSeconds: 60,
    });
    const { listing } = parseMarketplaceInput(
      z.object({ listing: z.unknown() }).strict(),
      await readJsonBody(request, 24000),
    );
    const offer = await publishOpenSeaListing(listing);
    invalidateOpenSeaOrdersCache(offer.orderHash);
    return Response.json({ offer }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return requestSecurityResponse(error);
  }
}
