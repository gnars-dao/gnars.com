import { unstable_cache } from "next/cache";
import type { Address } from "viem";
import { z } from "zod";
import { enforceRateLimit } from "@/lib/server/request-security";
import {
  marketplaceAddressSchema,
  marketplaceErrorResponse,
  marketplaceUintSchema,
  parseMarketplaceInput,
} from "@/services/marketplace-common";
import { COMMUNITY_CACHE_TAG, listCommunityMarketplace } from "@/services/marketplace-community";

export const dynamic = "force-dynamic";
const schema = z
  .object({ cursor: marketplaceUintSchema.optional(), owner: marketplaceAddressSchema.optional() })
  .strict();
const load = unstable_cache(listCommunityMarketplace, ["community-feed-v1"], {
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
    const page = await load(input.cursor, input.owner as Address | undefined);
    return Response.json(page, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}
