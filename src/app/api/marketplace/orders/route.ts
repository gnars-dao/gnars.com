import { revalidateTag } from "next/cache";
import { z } from "zod";
import { enforceRateLimit, readJsonBody } from "@/lib/server/request-security";
import { scheduleMarketplaceAnnouncement } from "@/services/marketplace-announcements";
import {
  MARKETPLACE_ORDERS_CACHE_TAG,
  marketplaceErrorResponse,
  parseMarketplaceInput,
} from "@/services/marketplace-common";
import { enforceMarketplaceBudget, saveMarketplaceOrder } from "@/services/marketplace-orders";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, { scope: "marketplace-create", limit: 10, windowSeconds: 60 });
    const { listing, source } = parseMarketplaceInput(
      z
        .object({
          listing: z.unknown(),
          source: z.enum(["gnars", "gnars-contract"]).default("gnars"),
        })
        .strict(),
      await readJsonBody(request, 24000),
    );
    await enforceMarketplaceBudget(request, "create");
    const offer = await saveMarketplaceOrder(listing, source);
    revalidateTag(MARKETPLACE_ORDERS_CACHE_TAG, { expire: 0 });
    await scheduleMarketplaceAnnouncement(offer, listing);
    return Response.json({ offer }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}
