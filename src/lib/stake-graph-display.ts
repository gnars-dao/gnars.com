import type { OrbitBacker } from "@/services/stake-graph";

export function hasVerifiedRewardRouting(backer: OrbitBacker): boolean {
  return backer.kind === "vault" || backer.routing === "verified-split";
}

export function formatMorpheusPrincipal(backer: OrbitBacker, locale: string): string | null {
  if (backer.kind !== "mor" || !backer.asset || !backer.tokenAmount) return null;
  const value = Number(backer.tokenAmount);
  if (!Number.isFinite(value) || value <= 0) return null;
  return `${value.toLocaleString(locale, { maximumSignificantDigits: 6 })} ${backer.asset === "steth" ? "stETH" : "USDC"}`;
}
