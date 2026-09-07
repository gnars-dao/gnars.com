import {
  enforceRateLimit,
  RequestSecurityError,
  requestSecurityResponse,
} from "@/lib/server/request-security";
import { getSwapTokenDirectory } from "@/services/swap-token-directory";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    if (
      (params.get("chainId") ?? "8453") !== "8453" ||
      params.getAll("chainId").length > 1 ||
      [...params.keys()].some((key) => key !== "chainId")
    )
      throw new RequestSecurityError(400, "Only the Base token directory is supported.");
    await enforceRateLimit(request, {
      scope: "swap-token-directory",
      limit: 60,
      windowSeconds: 60,
    });
    const directory = await getSwapTokenDirectory();
    const complete = Object.values(directory.sources).every((source) => source.available);
    return Response.json(directory, {
      headers: {
        "Cache-Control": complete ? "public, s-maxage=300, stale-while-revalidate=300" : "no-store",
      },
    });
  } catch (error) {
    return requestSecurityResponse(error);
  }
}
