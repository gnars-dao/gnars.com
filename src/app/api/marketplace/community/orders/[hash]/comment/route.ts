import { revalidateTag } from "next/cache";
import { communityCommentEditSchema } from "@/lib/marketplace/community-comment";
import {
  enforceRateLimit,
  readJsonBody,
  RequestSecurityError,
} from "@/lib/server/request-security";
import {
  marketplaceErrorResponse,
  marketplaceHashSchema,
  parseMarketplaceInput,
} from "@/services/marketplace-common";
import {
  COMMUNITY_CACHE_TAG,
  editCommunityOrderComment,
  getCommunityOrderComment,
} from "@/services/marketplace-community";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ hash: string }> };

export async function GET(request: Request, context: Context) {
  try {
    await enforceRateLimit(request, {
      scope: "community-comment-read",
      limit: 30,
      windowSeconds: 60,
    });
    const orderHash = parseMarketplaceInput(marketplaceHashSchema, (await context.params).hash);
    const offer = await getCommunityOrderComment(orderHash);
    return Response.json({ offer }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    await enforceRateLimit(request, {
      scope: "community-comment-edit",
      limit: 10,
      windowSeconds: 60,
    });
    const orderHash = parseMarketplaceInput(marketplaceHashSchema, (await context.params).hash);
    const input = parseMarketplaceInput(
      communityCommentEditSchema,
      await readJsonBody(request, 22000),
    );
    if (input.orderHash.toLowerCase() !== orderHash.toLowerCase())
      throw new RequestSecurityError(400, "Listing identity does not match the request path.");
    const offer = await editCommunityOrderComment(input);
    revalidateTag(COMMUNITY_CACHE_TAG, { expire: 0 });
    return Response.json({ offer }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}
