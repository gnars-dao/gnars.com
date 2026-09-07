import { z } from "zod";
import {
  enforceRateLimit,
  readJsonBody,
  requestSecurityResponse,
} from "@/lib/server/request-security";
import { marketplaceUintSchema, parseMarketplaceInput } from "@/services/marketplace-common";
import { getOpenSeaListingQuote } from "@/services/marketplace-opensea";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, {
      scope: "marketplace-opensea-quote",
      limit: 20,
      windowSeconds: 60,
    });
    const { priceWei } = parseMarketplaceInput(
      z
        .object({
          tokenId: marketplaceUintSchema,
          priceWei: marketplaceUintSchema.pipe(z.string().refine((value) => BigInt(value) > 0n)),
        })
        .strict(),
      await readJsonBody(request, 1024),
    );
    return Response.json(
      { quote: await getOpenSeaListingQuote(priceWei) },
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    return requestSecurityResponse(error);
  }
}
