import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { RouteMessages } from "@/i18n/RouteMessages";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "marketplace" });
  return {
    title: t("title"),
    description: t("description"),
    alternates: {
      canonical: locale === "en" ? "/marketplace" : "/pt-br/marketplace",
      languages: { en: "/marketplace", "pt-br": "/pt-br/marketplace", "x-default": "/marketplace" },
    },
  };
}

export default function MarketplaceLayout({ children }: { children: React.ReactNode }) {
  return <RouteMessages route="marketplace">{children}</RouteMessages>;
}
