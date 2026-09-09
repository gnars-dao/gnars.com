import { describe, expect, it, vi } from "vitest";
import { BASE_URL } from "@/lib/config";
import { generateMetadata } from "./layout";

vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => `marketplace.${key}`),
}));
vi.mock("@/i18n/RouteMessages", () => ({ RouteMessages: () => null }));

describe("marketplace share metadata", () => {
  for (const locale of ["en", "pt-br"]) {
    it(`shares the marketplace cover and destination for ${locale}`, async () => {
      const metadata = await generateMetadata({ params: Promise.resolve({ locale }) });
      const path = locale === "en" ? "/marketplace" : "/pt-br/marketplace";
      const image = `${BASE_URL}/marketplace-og-v1.jpg`;
      expect(metadata.alternates?.canonical).toBe(path);
      expect(metadata.openGraph).toMatchObject({
        url: `${BASE_URL}${path}`,
        title: "marketplace.title",
        images: [{ url: image, width: 1200, height: 630 }],
      });
      expect(metadata.twitter).toMatchObject({ card: "summary_large_image", images: [image] });
      const embed = JSON.parse(metadata.other!["fc:miniapp"] as string);
      expect(embed.imageUrl).toBe(image);
      expect(embed.button.action.url).toBe(`${BASE_URL}${path}`);
    });
  }
});
