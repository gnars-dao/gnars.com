import { unstable_cache } from "next/cache";
import type { Address } from "viem";
import { z } from "zod";
import {
  marketplaceBrowseFilterShape,
  parseMarketplaceBrowseFilters,
} from "@/lib/marketplace/browse-filters";
import { enforceRateLimit, RequestSecurityError } from "@/lib/server/request-security";
import {
  marketplaceAddressSchema,
  marketplaceErrorResponse,
  parseMarketplaceInput,
} from "@/services/marketplace-common";
import { COMMUNITY_CACHE_TAG, listCommunityMarketplace } from "@/services/marketplace-community";

export const dynamic = "force-dynamic";
const schema = z
  .object({
    cursor: z.string().max(2048).optional(),
    ...marketplaceBrowseFilterShape,
    owner: marketplaceAddressSchema.optional(),
    q: z
      .string()
      .trim()
      .max(100)
      .regex(/^[^\x00-\x1f\x7f]*$/)
      .optional(),
  })
  .strict();
const load = unstable_cache(listCommunityMarketplace, ["community-feed-v3"], {
  revalidate: 15,
  tags: [COMMUNITY_CACHE_TAG],
});
export async function GET(request: Request) {
  try {
    await enforceRateLimit(request, { scope: "community-read", limit: 60, windowSeconds: 60 });
    const input = parseMarketplaceInput(
      schema,
      Object.fromEntries(new URL(request.url).searchParams),
    );
    let filters;
    try {
      filters = parseMarketplaceBrowseFilters({
        sort: input.sort,
        minPriceWei: input.minPriceWei,
        maxPriceWei: input.maxPriceWei,
      });
    } catch {
      throw new RequestSecurityError(400, "Invalid marketplace price range.");
    }
    const page = Object.values(filters).some((value) => value !== undefined)
      ? await load(input.cursor, input.owner as Address | undefined, input.q || undefined, filters)
      : await load(input.cursor, input.owner as Address | undefined, input.q || undefined);
    return Response.json(page, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}
