/**
 * Bounty categories. The contract stores any 1–32 byte slug (emitted only in
 * `BountyCreated`); the allowed list lives here. Display order is fixed.
 */
export const SOPA_CATEGORIES = [
  "skate",
  "tech",
  "surf",
  "snow",
  "art",
  "parkour",
  "music",
  "weed",
  "creative",
] as const;

export type SopaCategory = (typeof SOPA_CATEGORIES)[number];

export function isSopaCategory(value: unknown): value is SopaCategory {
  return typeof value === "string" && (SOPA_CATEGORIES as readonly string[]).includes(value);
}
