import "server-only";
import { randomUUID } from "node:crypto";
import { createPublicClient, fallback, http, isAddress } from "viem";
import { base } from "viem/chains";
import { z } from "zod";
import { RequestSecurityError } from "@/lib/server/request-security";

export const marketplaceAddressSchema = z.string().refine(isAddress);
export const marketplaceHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const marketplaceUintSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .pipe(z.string().refine((value) => BigInt(value) < 2n ** 256n));
export const MARKETPLACE_PAGE_SIZE = 24;
export const MARKETPLACE_CACHE_TAG = "marketplace";
export const MARKETPLACE_ORDERS_CACHE_TAG = "marketplace-orders";
export const MARKETPLACE_OPENSEA_ORDERS_CACHE_TAG = "marketplace-opensea-orders";

export const marketplaceClient = createPublicClient({
  chain: base,
  transport: fallback(
    [
      ...(process.env.ALCHEMY_API_KEY
        ? [
            http(`https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`, {
              timeout: 5000,
              retryCount: 0,
            }),
          ]
        : []),
      http("https://mainnet.base.org", { timeout: 5000, retryCount: 0 }),
      http("https://base-rpc.publicnode.com", { timeout: 5000, retryCount: 0 }),
    ],
    { retryCount: 0 },
  ),
});

export class MarketplaceServiceError extends RequestSecurityError {
  readonly requestId = randomUUID();
  constructor(
    status: number,
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    retryAfter?: number,
  ) {
    super(status, message, retryAfter);
  }
}

export function marketplaceUnavailable(message = "Marketplace provider is unavailable.") {
  return new MarketplaceServiceError(503, message, "MARKETPLACE_UNAVAILABLE", true);
}

export function marketplaceSimulationError(error: unknown): MarketplaceServiceError {
  const details: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  for (
    let depth = 0;
    depth < 8 && current && typeof current === "object" && !seen.has(current);
    depth++
  ) {
    seen.add(current);
    const cause = current as {
      name?: unknown;
      message?: unknown;
      shortMessage?: unknown;
      cause?: unknown;
    };
    for (const value of [cause.name, cause.message, cause.shortMessage])
      if (typeof value === "string") details.push(value.slice(0, 10000));
    current = cause.cause;
  }
  // Match known causes locally; no raw RPC error, calldata or URL is returned.
  const reason = details.join(" ");
  if (
    /InsufficientFundsError|InsufficientBalanceError|insufficient (?:funds|balance)/i.test(reason)
  )
    return new MarketplaceServiceError(
      422,
      "The buyer has insufficient ETH for this transaction.",
      "INSUFFICIENT_BALANCE",
      false,
    );
  if (/ContractFunctionRevertedError|ExecutionRevertedError|execution reverted/i.test(reason))
    return new MarketplaceServiceError(
      409,
      "The transaction simulation reverted. Refresh the listing before trying again.",
      "SIMULATION_FAILED",
      false,
    );
  return new MarketplaceServiceError(
    503,
    "The transaction could not be simulated because the Base RPC is unavailable.",
    "MARKETPLACE_RPC_UNAVAILABLE",
    true,
  );
}

export function marketplaceErrorResponse(error: unknown): Response {
  const known = error instanceof RequestSecurityError;
  const status = known ? error.status : 500;
  const structured = error instanceof MarketplaceServiceError;
  const requestId = structured ? error.requestId : randomUUID();
  const code = structured ? error.code : status < 500 ? "INVALID_REQUEST" : "REQUEST_FAILED";
  console.warn("[marketplace] Request failed", { requestId, code, status });
  return Response.json(
    {
      error: known ? error.message : "Unable to complete marketplace request.",
      code,
      retryable: structured ? error.retryable : status === 429 || status >= 500,
      requestId,
    },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
        ...(known && error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {}),
      },
    },
  );
}

export function parseMarketplaceInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new RequestSecurityError(400, "Invalid marketplace request.");
  return result.data;
}
