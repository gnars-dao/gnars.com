import {
  enforceRateLimit,
  RequestSecurityError,
  requestSecurityResponse,
} from "@/lib/server/request-security";
import { parseTokenSourceAddresses } from "@/lib/swap-token-sources";
import { getSwapTokenSources } from "@/services/swap-token-sources";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
export async function GET(request: Request) {
  try {
    let addresses;
    try {
      addresses = parseTokenSourceAddresses(new URL(request.url).searchParams);
    } catch {
      throw new RequestSecurityError(400, "Provide up to 25 valid Base token addresses.");
    }
    await enforceRateLimit(request, {
      scope: "swap-token-sources",
      limit: 250,
      windowSeconds: 60,
      cost: addresses.length,
    });
    const result = await getSwapTokenSources(addresses);
    return Response.json(result, {
      headers: { "Cache-Control": result.complete ? "public, s-maxage=3600" : "no-store" },
    });
  } catch (error) {
    return requestSecurityResponse(error);
  }
}
