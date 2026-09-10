export interface ShopCardLabels {
  shopNow: string;
  viewDetails: string;
  soldOut: string;
  comingSoon: string;
  featured: string;
}

/**
 * Separation for a product cover, without a panel behind it.
 *
 * The artwork is transparent cutouts, so the page ground shows straight
 * through: a white garment vanished on the light theme, a black one on dark.
 * `drop-shadow` follows the alpha silhouette rather than the image box, so the
 * garment casts its own shadow the way it would in a product shot — it fixes
 * both directions with nothing drawn around it. The wash this replaces was
 * `dark:` only and could solve one direction at best.
 *
 * Dark flips it to a light halo: a black shadow buys nothing against a near
 * black ground.
 *
 * These are Tailwind filter utilities, not an arbitrary `filter:`, so they
 * compose with the `grayscale` the coming-soon covers also carry.
 */
export const COVER_SHADOW =
  "drop-shadow-[0_6px_10px_rgba(0,0,0,0.28)] dark:drop-shadow-[0_0_14px_rgba(255,255,255,0.22)]";

/** Same treatment, scaled for the featured card and the detail hero. */
export const COVER_SHADOW_LG =
  "drop-shadow-[0_10px_18px_rgba(0,0,0,0.30)] dark:drop-shadow-[0_0_22px_rgba(255,255,255,0.22)]";

export function formatPrice(priceUSD?: number) {
  if (priceUSD == null) return null;
  return `$${priceUSD.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/**
 * True when the card should link straight to an external storefront.
 *
 * `mailto:` inquiries and multi-image listings route through the detail page
 * instead so the buyer sees the product before contacting the vendor. The
 * status check matters as much as the rest: without it a coming-soon or
 * sold-out listing still linked out, labelled **Shop now** under its own
 * **Coming soon** badge, while the detail page correctly refused to sell it.
 * The card is the half people click, so the card has to agree.
 */
export function isDirectBuyLink(item: {
  type: string;
  status: string;
  externalUrl?: string;
  images: string[];
}) {
  return (
    item.type === "affiliate" &&
    item.status === "active" &&
    !!item.externalUrl &&
    !item.externalUrl.startsWith("mailto:") &&
    item.images.length <= 1
  );
}
