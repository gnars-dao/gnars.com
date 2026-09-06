import "server-only";
import { createPublicClient, fallback, http, isAddress } from "viem";
import { base } from "viem/chains";
import { z } from "zod";
import { RequestSecurityError } from "@/lib/server/request-security";

export const marketplaceAddressSchema = z.string().refine(isAddress);
export const marketplaceHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const marketplaceUintSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .refine((value) => BigInt(value) < 2n ** 256n);
export const MARKETPLACE_PAGE_SIZE = 24;
export const MARKETPLACE_CACHE_TAG = "marketplace";

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

export function marketplaceUnavailable(message = "Marketplace provider is unavailable.") {
  return new RequestSecurityError(503, message);
}

export function parseMarketplaceInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new RequestSecurityError(400, "Invalid marketplace request.");
  return result.data;
}
