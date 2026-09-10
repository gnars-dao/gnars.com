import { z } from "zod";
import { enforceRateLimit, readJsonBody } from "@/lib/server/request-security";
import { scheduleMarketplaceAnnouncement } from "@/services/marketplace-announcements";
import { marketplaceErrorResponse, parseMarketplaceInput } from "@/services/marketplace-common";
import {
  invalidateOpenSeaOrdersCache,
  publishOpenSeaListing,
} from "@/services/marketplace-opensea";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
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
    await scheduleMarketplaceAnnouncement(offer, listing);
    return Response.json({ offer }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}
