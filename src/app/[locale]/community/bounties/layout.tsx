import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "metadata.bounties" });
  const path = "/community/bounties";
  const canonical = locale === "en" ? path : `/pt-br${path}`;
  return {
    title: t("title"),
    description: t("description"),
    alternates: {
      canonical,
      languages: {
        en: path,
        "pt-br": `/pt-br${path}`,
        "x-default": path,
      },
    },
    openGraph: {
      images: [
        {
          url: "https://gnars.com/images/bounties-preview-zima.jpg",
          width: 1200,
          height: 630,
          alt: "Gnars DAO Bounties — Build it. Prove it. Get rewarded.",
        },
      ],
      title: t("title"),
      description: t("description"),
      type: "website",
      url: `https://gnars.com${path}`,
      locale: locale === "pt-br" ? "pt_BR" : "en_US",
    },
    twitter: {
      card: "summary_large_image",
      images: [
        {
          url: "https://gnars.com/images/bounties-preview-zima.jpg",
          width: 1200,
          height: 630,
          alt: "Gnars DAO Bounties — Build it. Prove it. Get rewarded.",
        },
      ],
      title: t("title"),
      description: t("description"),
    },
    other: {
      "fc:frame": JSON.stringify({
        version: "next",
        imageUrl: "https://gnars.com/images/bounties-preview-zima.jpg",
        button: {
          title: "View Challenges",
          action: {
            type: "launch_frame",
            name: "Gnars Challenges",
            url: "https://gnars.com/community/bounties",
            splashImageUrl: "https://gnars.com/images/bounties-preview-zima.jpg",
          },
        },
      }),
    },
  };
}

export default function BountiesLayout({ children }: { children: React.ReactNode }) {
  return children;
}
