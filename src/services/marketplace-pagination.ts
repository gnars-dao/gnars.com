import "server-only";
import { z } from "zod";
import type { MarketplaceBrowseFilters } from "@/lib/marketplace/browse-filters";
import { RequestSecurityError } from "@/lib/server/request-security";

const positionSchema = z
  .object({
    id: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .max(19)
      .refine((value) => BigInt(value) <= 9223372036854775807n),
    price: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .max(78)
      .optional(),
    source: z.enum(["gnars", "gnars-contract"]).optional(),
  })
  .strict();
export type MarketplacePosition = z.infer<typeof positionSchema>;
export function browseIdentity(filters: MarketplaceBrowseFilters, owner?: string, search?: string) {
  return JSON.stringify([
    filters.sort ?? null,
    filters.minPriceWei ?? null,
    filters.maxPriceWei ?? null,
    owner?.toLowerCase() ?? null,
    search ?? null,
  ]);
}
export function encodeBrowseCursor(position: MarketplacePosition, identity: string) {
  return Buffer.from(JSON.stringify({ ...position, identity })).toString("base64url");
}
export function decodeBrowseCursor(raw: string | undefined, identity: string) {
  if (!raw) return undefined;
  try {
    if (raw.length > 2048) throw new Error("Cursor too long");
    const parsed = positionSchema
      .extend({ identity: z.literal(identity) })
      .strict()
      .parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return parsed;
  } catch {
    throw new RequestSecurityError(400, "Invalid marketplace cursor.");
  }
}
