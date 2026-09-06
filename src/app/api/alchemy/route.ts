import { unstable_cache } from "next/cache";
import { alchemyRequestSchema } from "@/lib/alchemy-request";
import {
  enforceRateLimit,
  readJsonBody,
  RequestSecurityError,
  requestSecurityResponse,
} from "@/lib/server/request-security";

async function readRpc(method: string, params: unknown[]) {
  const apiKey = process.env.ALCHEMY_API_KEY;
  const fallback = process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://mainnet.base.org";
  if (!apiKey && method !== "eth_getBalance")
    throw new RequestSecurityError(503, "Token service is not configured.");
  const url = apiKey ? `https://base-mainnet.g.alchemy.com/v2/${apiKey}` : fallback;
  const rpcParams =
    method === "eth_getBalance" && params.length === 1 ? [...params, "latest"] : params;
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: rpcParams });
  const fetchRpc = (endpoint: string) =>
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
  let response = await fetchRpc(url);
  if (!response.ok && method === "eth_getBalance" && url !== fallback)
    response = await fetchRpc(fallback);
  if (!response.ok) throw new RequestSecurityError(502, "RPC provider is unavailable.");
  const data = await response.json();
  if (!data || data.error || !("result" in data))
    throw new RequestSecurityError(502, "Invalid RPC response.");
  return data;
}

// Cache only validated successful JSON-RPC results, never HTTP-200 provider errors.
const readMetadata = unstable_cache(readRpc, ["alchemy-metadata-v1"], { revalidate: 3600 });
const readBalance = unstable_cache(readRpc, ["alchemy-balance-v1"], { revalidate: 15 });

export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, { scope: "alchemy", limit: 120, windowSeconds: 60 });
    const parsed = alchemyRequestSchema.safeParse(await readJsonBody(request, 8192));
    if (!parsed.success)
      throw new RequestSecurityError(400, "Unsupported RPC method or invalid parameters.");
    const { method, params } = parsed.data;
    const data = await (method === "alchemy_getTokenMetadata" ? readMetadata : readBalance)(
      method,
      params,
    );
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return requestSecurityResponse(error);
  }
}
