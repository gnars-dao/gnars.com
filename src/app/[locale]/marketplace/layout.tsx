import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { RouteMessages } from "@/i18n/RouteMessages";
import { BASE_URL } from "@/lib/config";
import { launchMiniappEmbed } from "@/lib/miniapp-config";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "marketplace" });
  const canonical = locale === "en" ? "/marketplace" : "/pt-br/marketplace";
  const image = `${BASE_URL}/marketplace-og-v1.jpg`;
  return {
    title: t("title"),
    description: t("description"),
    alternates: {
      canonical,
      languages: { en: "/marketplace", "pt-br": "/pt-br/marketplace", "x-default": "/marketplace" },
    },
    openGraph: {
      title: t("title"),
      description: t("description"),
      url: `${BASE_URL}${canonical}`,
      type: "website",
      locale: locale === "pt-br" ? "pt_BR" : "en_US",
      images: [{ url: image, width: 1200, height: 630, alt: t("title") }],
    },
    twitter: {
      card: "summary_large_image",
      title: t("title"),
      description: t("description"),
      images: [image],
    },
    other: {
      "fc:miniapp": JSON.stringify({
        ...launchMiniappEmbed(canonical, t("title"), t("title")),
        imageUrl: image,
      }),
    },
  };
}

export default function MarketplaceLayout({ children }: { children: React.ReactNode }) {
  return <RouteMessages route="marketplace">{children}</RouteMessages>;
}
