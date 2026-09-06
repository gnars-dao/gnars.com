import { revalidateTag } from "next/cache";
import { z } from "zod";
import {
  enforceRateLimit,
  readJsonBody,
  requestSecurityResponse,
} from "@/lib/server/request-security";
import { MARKETPLACE_ORDERS_CACHE_TAG, parseMarketplaceInput } from "@/services/marketplace-common";
import { enforceMarketplaceBudget, saveMarketplaceOrder } from "@/services/marketplace-orders";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, { scope: "marketplace-create", limit: 10, windowSeconds: 60 });
    const { listing } = parseMarketplaceInput(
      z.object({ listing: z.unknown() }).strict(),
      await readJsonBody(request, 24000),
    );
    await enforceMarketplaceBudget(request, "create");
    const offer = await saveMarketplaceOrder(listing);
    revalidateTag(MARKETPLACE_ORDERS_CACHE_TAG, { expire: 0 });
    return Response.json({ offer }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return requestSecurityResponse(error);
  }
}
