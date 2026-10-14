import { unstable_cache } from "next/cache";
import { z } from "zod";
import { EXTERNAL_COLLECTION_KEYS } from "@/lib/marketplace/external-collections";
import { enforceRateLimit } from "@/lib/server/request-security";
import { marketplaceErrorResponse, parseMarketplaceInput } from "@/services/marketplace-common";
import {
  EXTERNAL_COLLECTION_CACHE_TAG,
  listExternalCollection,
} from "@/services/marketplace-external-collections";

export const dynamic = "force-dynamic";
const schema = z.object({ collection: z.enum(EXTERNAL_COLLECTION_KEYS) }).strict();
const load = unstable_cache(listExternalCollection, ["external-collection-v1"], {
  revalidate: 60,
  tags: [EXTERNAL_COLLECTION_CACHE_TAG],
});

export async function GET(request: Request) {
  try {
    await enforceRateLimit(request, {
      scope: "external-collection-read",
      limit: 60,
      windowSeconds: 60,
    });
    const input = parseMarketplaceInput(
      schema,
      Object.fromEntries(new URL(request.url).searchParams),
    );
    return Response.json(await load(input.collection), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}
