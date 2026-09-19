import type { Address } from "viem";
import { z } from "zod";
import { enforceRateLimit } from "@/lib/server/request-security";
import {
  marketplaceAddressSchema,
  marketplaceErrorResponse,
  marketplaceUintSchema,
  parseMarketplaceInput,
} from "@/services/marketplace-common";
import { getMarketplaceTraits } from "@/services/marketplace-traits";

export const dynamic = "force-dynamic";
const schema = z
  .object({ collection: marketplaceAddressSchema, tokenId: marketplaceUintSchema })
  .strict();

export async function GET(request: Request) {
  try {
    await enforceRateLimit(request, { scope: "marketplace-traits", limit: 30, windowSeconds: 60 });
    const input = parseMarketplaceInput(
      schema,
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const result = await getMarketplaceTraits(input.collection as Address, input.tokenId);
    return Response.json(result, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60" },
    });
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}
