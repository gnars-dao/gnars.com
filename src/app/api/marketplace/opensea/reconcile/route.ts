import type { Hex } from "viem";
import { z } from "zod";
import {
  enforceRateLimit,
  readJsonBody,
  requestSecurityResponse,
} from "@/lib/server/request-security";
import { marketplaceHashSchema, parseMarketplaceInput } from "@/services/marketplace-common";
import {
  invalidateOpenSeaOrdersCache,
  reconcileOpenSeaOrder,
} from "@/services/marketplace-opensea";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, {
      scope: "marketplace-opensea-reconcile",
      limit: 10,
      windowSeconds: 60,
    });
    const { orderHash } = parseMarketplaceInput(
      z.object({ orderHash: marketplaceHashSchema }).strict(),
      await readJsonBody(request, 1024),
    );
    const result = await reconcileOpenSeaOrder(orderHash as Hex);
    if (result.status === "cancelled" || result.status === "filled")
      invalidateOpenSeaOrdersCache(orderHash as Hex);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return requestSecurityResponse(error);
  }
}
