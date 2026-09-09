/**
 * Copy for the /stake and /base share cards.
 *
 * Each page now renders two cards — the 1.91:1 link preview and the 3:2
 * Farcaster embed — and the layouts genuinely differ (a 3:2 canvas has room the
 * wide one doesn't). The wording must not: EN and PT-BR drifting between the
 * two is exactly the bug that hides until someone shares the wrong one. So the
 * strings live here once and the pixels stay with each route.
 */

export const STAKE_GOLD = "#f7c948";
export const MOR_GREEN = "#2be58b";
export const BASE_BLUE = "#0052FF";

export function stakeCardLabels(isPt: boolean) {
  return {
    title: "STAKE OR DIE",
    sub: isPt
      ? "Apoie um rider da Gnars ou a subnet Gnars Builder na Morpheus"
      : "Back a Gnars rider, or the Gnars Builder subnet on Morpheus",
    a: isPt ? "Vaults dos riders" : "Rider vaults",
    aDesc: isPt ? "stETH · USDC · rendimento compartilhado" : "stETH · USDC · shared yield",
    b: isPt ? "Subnet na Morpheus" : "Morpheus subnet",
    bDesc: isPt ? "MOR na Base · trava de 7 dias" : "MOR on Base · 7-day lock",
    footer: isPt ? "gnars.com/pt-br/stake" : "gnars.com/stake",
  };
}

export function baseCardLabels(isPt: boolean) {
  return {
    eyebrow: isPt ? "CONSTRUÍDO NA BASE · CHAIN 8453" : "BUILT ON BASE · CHAIN 8453",
    title: isPt ? "A Gnars roda inteira na Base" : "Gnars runs entirely on Base",
    features: isPt
      ? ["Leilões diários", "Governança onchain", "Tesouro", "Droposals", "Swap", "Staking"]
      : ["Daily auctions", "Onchain governance", "Treasury", "Droposals", "Swap", "Staking"],
    footer: isPt ? "gnars.com/pt-br/base" : "gnars.com/base",
  };
}
