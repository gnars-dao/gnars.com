import { RouteMessages } from "@/i18n/RouteMessages";

export default function MarketplaceLayout({ children }: { children: React.ReactNode }) {
  return <RouteMessages route="marketplace">{children}</RouteMessages>;
}
