import { enforceRateLimit } from "@/lib/server/request-security";
import { marketplaceErrorResponse, parseMarketplaceInput } from "@/services/marketplace-common";
import {
  getMarketplaceWalletNfts,
  marketplaceWalletQuerySchema,
} from "@/services/marketplace-wallet-nfts";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await enforceRateLimit(request, { scope: "community-wallet", limit: 30, windowSeconds: 60 });
    const { owner, cursor, collection } = parseMarketplaceInput(
      marketplaceWalletQuerySchema,
      Object.fromEntries(new URL(request.url).searchParams),
    );
    return Response.json(await getMarketplaceWalletNfts(owner, cursor, collection), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}
