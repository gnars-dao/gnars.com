import { getTranslations } from "next-intl/server";

/**
 * Boundary for `notFound()` in the product route, so a retired slug answers 404
 * while keeping the localised copy the inline branch used to render.
 */
export default async function ShopItemNotFound() {
  const t = await getTranslations("shop");

  return (
    <div className="py-8 text-center">
      <h2 className="text-2xl font-bold text-muted-foreground">{t("notFound.title")}</h2>
      <p className="mt-2 text-muted-foreground">{t("notFound.description")}</p>
    </div>
  );
}
