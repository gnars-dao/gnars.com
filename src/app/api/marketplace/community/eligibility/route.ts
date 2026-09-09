import type { Address } from "viem";
import { z } from "zod";
import { enforceRateLimit } from "@/lib/server/request-security";
import {
  marketplaceAddressSchema,
  marketplaceErrorResponse,
  parseMarketplaceInput,
} from "@/services/marketplace-common";
import { getCommunityEligibility } from "@/services/marketplace-community";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    await enforceRateLimit(request, {
      scope: "community-eligibility",
      limit: 30,
      windowSeconds: 60,
    });
    const { owner } = parseMarketplaceInput(
      z.object({ owner: marketplaceAddressSchema }).strict(),
      Object.fromEntries(new URL(request.url).searchParams),
    );
    return Response.json(await getCommunityEligibility(owner as Address), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}
