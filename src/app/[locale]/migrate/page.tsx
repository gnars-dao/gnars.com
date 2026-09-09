import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { BASE_URL } from "@/lib/config";
import { MIGRATE_MINIAPP_EMBED_CONFIG } from "@/lib/miniapp-config";
import { MigrateStatusChip } from "./MigrateStatusChip";
import { MigrationWidget } from "./MigrationWidget";

const miniappImage = `${BASE_URL}/migrate/miniapp-image`;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "metadata.migrate" });
  const path = "/migrate";
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
      title: t("title"),
      description: t("description"),
      images: [miniappImage],
      url: `${BASE_URL}/migrate`,
      type: "website",
      locale: locale === "pt-br" ? "pt_BR" : "en_US",
    },
    twitter: {
      card: "summary_large_image",
      title: t("title"),
      description: t("description"),
      images: [miniappImage],
    },
    // Farcaster mini app embed metadata — a cast linking to /migrate renders
    // the migration cover + a "Migrate to $gnars" launch button. The global
    // MiniAppReady (in [locale]/layout.tsx) handles sdk.actions.ready().
    other: {
      "fc:miniapp": JSON.stringify(MIGRATE_MINIAPP_EMBED_CONFIG),
    },
  };
}

export default async function MigratePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("migrate");

  const guideSteps = t.raw("guide.steps") as { title: string; body: string }[];

  return (
    <div className="py-12">
      <div className="mx-auto max-w-5xl space-y-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1.5">
            <h1 className="text-3xl font-bold tracking-tight">{t("title")}</h1>
            <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
          </div>
          <MigrateStatusChip />
        </div>

        <MigrationWidget />

        <div className="space-y-4 border-t pt-6">
          <div className="grid gap-6 sm:grid-cols-3">
            {guideSteps.map((step, i) => (
              <div key={i} className="space-y-1">
                <div className="text-sm font-semibold">{step.title}</div>
                <p className="text-[13px] text-muted-foreground">{step.body}</p>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t("guide.footnote")}</p>
        </div>
      </div>
    </div>
  );
}
