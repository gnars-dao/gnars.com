import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Marketplace } from "@/components/marketplace/Marketplace";
import {
  buildMarketplaceShareUrl,
  MARKETPLACE_SHARE_ORIGIN,
  parseMarketplaceShareQuery,
} from "@/lib/marketplace/share";
import { loadMarketplacePage } from "@/services/marketplace";
import { getMarketplaceShareData } from "@/services/marketplace-share";

export const revalidate = 60;

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "marketplace" });
  const target = parseMarketplaceShareQuery(await searchParams);
  const data = target ? await getMarketplaceShareData(target) : null;
  const genericPath = locale === "pt-br" ? "/pt-br/marketplace" : "/marketplace";
  const canonical = target
    ? buildMarketplaceShareUrl({ ...target, locale })
    : `${MARKETPLACE_SHARE_ORIGIN}${genericPath}`;
  const miniappImage = new URL(canonical);
  miniappImage.pathname += "/miniapp-image";
  const image = data ? miniappImage.href : `${MARKETPLACE_SHARE_ORIGIN}/marketplace-og-v1.jpg`;
  const title = data ? `${data.name} | ${t("title")}` : t("title");
  const embed = {
    version: "1",
    imageUrl: miniappImage.href,
    button: {
      title: t(target ? "share.openNft" : "share.openMarketplace"),
      action: {
        type: "launch_miniapp",
        name: "Gnars Marketplace",
        url: canonical,
        splashImageUrl: `${MARKETPLACE_SHARE_ORIGIN}/gnars-splash-200.png`,
        splashBackgroundColor: "#000000",
      },
    },
  };
  const localizedUrl = (language: string) =>
    target
      ? buildMarketplaceShareUrl({ ...target, locale: language })
      : `${MARKETPLACE_SHARE_ORIGIN}${language === "pt-br" ? "/pt-br" : ""}/marketplace`;
  return {
    title,
    description: t("description"),
    alternates: {
      canonical,
      languages: {
        en: localizedUrl("en"),
        "pt-br": localizedUrl("pt-br"),
        "x-default": localizedUrl("en"),
      },
    },
    openGraph: {
      title,
      description: t("description"),
      url: canonical,
      type: "website",
      locale: locale === "pt-br" ? "pt_BR" : "en_US",
      images: [{ url: image, width: 1200, height: data ? 800 : 630, alt: title }],
    },
    twitter: { card: "summary_large_image", title, description: t("description"), images: [image] },
    other: {
      "fc:miniapp": JSON.stringify(embed),
      "fc:frame": JSON.stringify({
        ...embed,
        button: { ...embed.button, action: { ...embed.button.action, type: "launch_frame" } },
      }),
    },
  };
}

export default async function MarketplacePage() {
  const initialPage = await loadMarketplacePage({ view: "listings" }).catch(() => undefined);
  return <Marketplace initialPage={initialPage} />;
}
