import { revalidateTag } from "next/cache";
import { z } from "zod";
import {
  enforceRateLimit,
  readJsonBody,
  requestSecurityResponse,
} from "@/lib/server/request-security";
import {
  MARKETPLACE_ORDERS_CACHE_TAG,
  marketplaceHashSchema,
  parseMarketplaceInput,
} from "@/services/marketplace-common";
import { enforceMarketplaceBudget, reconcileMarketplaceOrder } from "@/services/marketplace-orders";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, {
      scope: "marketplace-reconcile",
      limit: 10,
      windowSeconds: 60,
    });
    const { orderHash } = parseMarketplaceInput(
      z.object({ orderHash: marketplaceHashSchema }).strict(),
      await readJsonBody(request, 1024),
    );
    await enforceMarketplaceBudget(request, "reconcile");
    const { status } = await reconcileMarketplaceOrder(orderHash);
    revalidateTag(MARKETPLACE_ORDERS_CACHE_TAG, { expire: 0 });
    return Response.json({ status }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return requestSecurityResponse(error);
  }
}
