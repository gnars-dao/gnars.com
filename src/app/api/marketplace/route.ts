import type { Address } from "viem";
import { z } from "zod";
import {
  marketplaceBrowseFilterShape,
  parseMarketplaceBrowseFilters,
} from "@/lib/marketplace/browse-filters";
import { enforceRateLimit, RequestSecurityError } from "@/lib/server/request-security";
import { loadMarketplacePage } from "@/services/marketplace";
import {
  marketplaceAddressSchema,
  marketplaceErrorResponse,
  marketplaceUintSchema,
  parseMarketplaceInput,
} from "@/services/marketplace-common";

export const dynamic = "force-dynamic";
const querySchema = z
  .object({
    view: z.enum(["listings", "catalogue", "owned", "selling"]).default("listings"),
    owner: marketplaceAddressSchema.optional(),
    cursor: z.string().max(8192).optional(),
    tokenId: marketplaceUintSchema.optional(),
    ...marketplaceBrowseFilterShape,
  })
  .strict();

export async function GET(request: Request) {
  try {
    await enforceRateLimit(request, { scope: "marketplace-read", limit: 60, windowSeconds: 60 });
    const query = parseMarketplaceInput(
      querySchema,
      Object.fromEntries(new URL(request.url).searchParams),
    );
    try {
      parseMarketplaceBrowseFilters({
        sort: query.sort,
        minPriceWei: query.minPriceWei,
        maxPriceWei: query.maxPriceWei,
        traits: query.traits,
        traitSnapshot: query.traitSnapshot,
      });
    } catch {
      throw new RequestSecurityError(400, "Invalid marketplace price range.");
    }
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
