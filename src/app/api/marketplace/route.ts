import type { Address } from "viem";
import { z } from "zod";
import { enforceRateLimit } from "@/lib/server/request-security";
import { loadMarketplacePage } from "@/services/marketplace";
import {
  marketplaceAddressSchema,
  marketplaceErrorResponse,
  parseMarketplaceInput,
} from "@/services/marketplace-common";

export const dynamic = "force-dynamic";
const querySchema = z
  .object({
    view: z.enum(["listings", "catalogue", "owned", "selling"]).default("listings"),
    owner: marketplaceAddressSchema.optional(),
    cursor: z.string().max(2048).optional(),
  })
  .strict();

export async function GET(request: Request) {
  try {
    await enforceRateLimit(request, { scope: "marketplace-read", limit: 60, windowSeconds: 60 });
    const query = parseMarketplaceInput(
      querySchema,
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const page = await loadMarketplacePage({ ...query, owner: query.owner as Address | undefined });
    const degraded = Object.values(page.sources).some(
      (source) => source.error === "unavailable" || source.partial,
    );
    return Response.json(page, {
      headers: {
        "Cache-Control":
          query.view === "owned" || query.view === "selling" || degraded
            ? "no-store"
            : "public, s-maxage=15, stale-while-revalidate=15",
      },
    });
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}
