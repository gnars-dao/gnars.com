import { z } from "zod";
import { enforceRateLimit } from "@/lib/server/request-security";
import {
  marketplaceAddressSchema,
  marketplaceErrorResponse,
  marketplaceUintSchema,
  parseMarketplaceInput,
} from "@/services/marketplace-common";
import { getCommunityToken } from "@/services/marketplace-community";

export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ collection: string; tokenId: string }> },
) {
  try {
    await enforceRateLimit(request, { scope: "community-metadata", limit: 30, windowSeconds: 60 });
    const { collection, tokenId } = parseMarketplaceInput(
      z.object({ collection: marketplaceAddressSchema, tokenId: marketplaceUintSchema }).strict(),
      await context.params,
    );
    parseMarketplaceInput(
      z.object({ owner: marketplaceAddressSchema.optional() }).strict(),
      Object.fromEntries(new URL(request.url).searchParams),
    );
    return Response.json(await getCommunityToken(collection, tokenId), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}
