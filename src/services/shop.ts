import shopData from "@/data/shop.json";
import type { ShopItem } from "@/types/shop";

const items = (shopData.items ?? []) as ShopItem[];

/**
 * Strips the buy URL from anything nobody can buy yet.
 *
 * `ShopGrid` is a client component and receives whole items, so every field is
 * serialized into the RSC payload whether or not a link renders — hiding the
 * anchor does not hide the address. For the Nogenta listings that address is a
 * third party's personal inbox, and it would sit in page source for scrapers
 * months before they intend to take inquiries. So it never leaves the server
 * until the listing goes `active`.
 */
function toPublicItem(item: ShopItem): ShopItem {
  if (item.status === "active") return item;
  const copy = { ...item };
  delete copy.externalUrl;
  return copy;
}

export async function getAllShopItems(): Promise<ShopItem[]> {
  return items.map(toPublicItem);
}

export async function getShopItemsByType(type: ShopItem["type"]): Promise<ShopItem[]> {
  return items.filter((item) => item.type === type).map(toPublicItem);
}

export async function getFeaturedShopItems(): Promise<ShopItem[]> {
  return items.filter((item) => item.featured).map(toPublicItem);
}

export async function getShopItemBySlug(slug: string): Promise<ShopItem | null> {
  const item = items.find((entry) => entry.slug === slug);
  return item ? toPublicItem(item) : null;
}
