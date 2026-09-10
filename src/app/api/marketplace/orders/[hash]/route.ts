import { z } from "zod";
import { corsPreflight, withCors } from "@/lib/server/cors";
import { enforceRateLimit } from "@/lib/server/request-security";
import {
  marketplaceErrorResponse,
  marketplaceHashSchema,
  parseMarketplaceInput,
} from "@/services/marketplace-common";
import { getMarketplaceOrder } from "@/services/marketplace-orders";

export const dynamic = "force-dynamic";
export const GET = withCors(
  async (request: Request, context: { params: Promise<{ hash: string }> }) => {
    try {
      await enforceRateLimit(request, { scope: "marketplace-read", limit: 60, windowSeconds: 60 });
      const hash = parseMarketplaceInput(marketplaceHashSchema, (await context.params).hash);
      const source = parseMarketplaceInput(
        z.enum(["gnars", "gnars-contract"]),
        new URL(request.url).searchParams.get("source") ?? "gnars",
      );
      return Response.json(
        { listing: await getMarketplaceOrder(hash, source) },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      return marketplaceErrorResponse(error);
    }
  },
);

export const OPTIONS = (request: Request) => corsPreflight(request, ["GET", "OPTIONS"]);
