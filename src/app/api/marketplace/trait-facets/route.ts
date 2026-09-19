import { z } from "zod";
import { enforceRateLimit } from "@/lib/server/request-security";
import { marketplaceErrorResponse, parseMarketplaceInput } from "@/services/marketplace-common";
import { getMarketplaceTraitFacets } from "@/services/marketplace-trait-index";

export const dynamic = "force-dynamic";
const querySchema = z
  .object({
    snapshotId: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();

export async function GET(request: Request) {
  try {
    await enforceRateLimit(request, {
      scope: "marketplace-trait-facets",
      limit: 30,
      windowSeconds: 60,
    });
    const query = parseMarketplaceInput(
      querySchema,
      Object.fromEntries(new URL(request.url).searchParams),
    );
    return Response.json(await getMarketplaceTraitFacets(query.snapshotId), {
      headers: { "Cache-Control": "public, s-maxage=60" },
    });
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}
