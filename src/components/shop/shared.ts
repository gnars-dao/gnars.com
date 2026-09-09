export interface ShopCardLabels {
  shopNow: string;
  viewDetails: string;
  soldOut: string;
  comingSoon: string;
  featured: string;
}

/**
 * Plate behind a product cover.
 *
 * The artwork is transparent cutouts, so the page ground shows straight
 * through. Without a plate a white garment disappeared on the light theme and a
 * black one on dark — both read as an empty tile. The wash this replaces was
 * `dark:` only, so it could only ever solve one of those directions. A neutral
 * panel plus its ring gives the tile a shape even where the garment and the
 * ground are the same colour.
 */
export const COVER_PLATE =
  "pointer-events-none absolute inset-0 rounded-lg bg-black/[0.055] ring-1 ring-inset ring-black/[0.06] dark:bg-white/[0.07] dark:ring-white/[0.08] dark:[background-image:radial-gradient(circle_at_center,rgba(255,255,255,0.10),transparent_65%)]";

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
