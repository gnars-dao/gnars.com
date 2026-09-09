import { revalidateTag } from "next/cache";
import { z } from "zod";
import { enforceRateLimit, readJsonBody } from "@/lib/server/request-security";
import {
  MARKETPLACE_ORDERS_CACHE_TAG,
  marketplaceErrorResponse,
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
    const { orderHash, source } = parseMarketplaceInput(
      z
        .object({
          orderHash: marketplaceHashSchema,
          source: z.enum(["gnars", "gnars-contract"]).default("gnars"),
        })
        .strict(),
      await readJsonBody(request, 1024),
    );
    await enforceMarketplaceBudget(request, "reconcile");
    const { status } = await reconcileMarketplaceOrder(orderHash, source);
    revalidateTag(MARKETPLACE_ORDERS_CACHE_TAG, { expire: 0 });
    return Response.json({ status }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}
