import { revalidateTag } from "next/cache";
import { z } from "zod";
import {
  enforceRateLimit,
  readJsonBody,
  RequestSecurityError,
} from "@/lib/server/request-security";
import {
  marketplaceErrorResponse,
  marketplaceUintSchema,
  parseMarketplaceInput,
} from "@/services/marketplace-common";
import {
  COMMUNITY_CACHE_TAG,
  communityModerationSchema,
  listCommunityModeration,
  moderateCommunityOrder,
} from "@/services/marketplace-community";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    await enforceRateLimit(request, {
      scope: "community-moderation-read",
      limit: 20,
      windowSeconds: 60,
    });
    const { cursor } = parseMarketplaceInput(
      z.object({ cursor: marketplaceUintSchema.optional() }).strict(),
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const header = request.headers.get("x-wallet-authorization");
    if (!header || header.length > 20000)
      throw new RequestSecurityError(401, "Signed moderator request is required.");
    let authorization: unknown;
    try {
      authorization = JSON.parse(header);
    } catch {
      throw new RequestSecurityError(401, "Invalid moderator authorization.");
    }
    return Response.json(await listCommunityModeration(authorization, cursor), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, {
      scope: "community-moderation",
      limit: 10,
      windowSeconds: 60,
    });
    const input = parseMarketplaceInput(
      communityModerationSchema,
      await readJsonBody(request, 22000),
    );
    const result = await moderateCommunityOrder(input);
    revalidateTag(COMMUNITY_CACHE_TAG, { expire: 0 });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}
