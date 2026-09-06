import { Marketplace } from "@/components/marketplace/Marketplace";
import { loadMarketplacePage } from "@/services/marketplace";

export const revalidate = 60;

export default async function MarketplacePage() {
  const initialPage = await loadMarketplacePage({ view: "catalogue" }).catch(() => undefined);
  return <Marketplace initialPage={initialPage} />;
}
