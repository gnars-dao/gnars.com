import { z } from "zod";
import { enforceRateLimit, RequestSecurityError } from "@/lib/server/request-security";
import {
  marketplaceErrorResponse,
  marketplaceUintSchema,
  parseMarketplaceInput,
} from "@/services/marketplace-common";
import { listCommunityManagedOrders } from "@/services/marketplace-community";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await enforceRateLimit(request, { scope: "community-manage", limit: 20, windowSeconds: 60 });
    const { cursor } = parseMarketplaceInput(
      z.object({ cursor: marketplaceUintSchema.optional() }).strict(),
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const header = request.headers.get("x-wallet-authorization");
    if (!header || header.length > 20000)
      throw new RequestSecurityError(401, "Signed seller request is required.");
    let authorization: unknown;
    try {
      authorization = JSON.parse(header);
    } catch {
      throw new RequestSecurityError(401, "Invalid seller authorization.");
    }
    return Response.json(await listCommunityManagedOrders(authorization, cursor), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}
