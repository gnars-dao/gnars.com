import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMarketplaceShareData } from "@/services/marketplace-share";
import { generateMetadata } from "./page";

vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(
    async ({ locale }: { locale: string }) =>
      (key: string) =>
        ({
          title: "Gnars Marketplace",
          description: "NFT marketplace",
          "share.openNft": locale === "pt-br" ? "Ver NFT" : "View NFT",
          "share.openMarketplace": locale === "pt-br" ? "Abrir marketplace" : "Open marketplace",
        })[key],
  ),
}));
vi.mock("@/components/marketplace/Marketplace", () => ({ Marketplace: () => null }));
vi.mock("@/services/marketplace", () => ({ loadMarketplacePage: vi.fn() }));
vi.mock("@/services/marketplace-share", () => ({ getMarketplaceShareData: vi.fn() }));

const make = (locale: string, query: Record<string, string | string[] | undefined> = {}) =>
  generateMetadata({ params: Promise.resolve({ locale }), searchParams: Promise.resolve(query) });

describe("marketplace share metadata", () => {
  beforeEach(() => vi.mocked(getMarketplaceShareData).mockReset());
  for (const locale of ["en", "pt-br"]) {
    it(`uses a separate 3:2 miniapp image and canonical signed domain for ${locale}`, async () => {
      const metadata = await make(locale);
      const url = `https://gnars.com${locale === "pt-br" ? "/pt-br" : ""}/marketplace`;
      expect(metadata.alternates?.canonical).toBe(url);
      expect(metadata.openGraph).toMatchObject({
        url,
        images: [{ url: "https://gnars.com/marketplace-og-v1.jpg", width: 1200, height: 630 }],
      });
      const embed = JSON.parse(metadata.other!["fc:miniapp"] as string);
      expect(embed.imageUrl).toBe(`${url}/miniapp-image`);
      expect(embed.button.title).toBe(
        locale === "pt-br" ? "Abrir marketplace" : "Open marketplace",
      );
      expect(embed.button.action).toMatchObject({ type: "launch_miniapp", url });
      expect(JSON.parse(metadata.other!["fc:frame"] as string).button.action).toMatchObject({
        type: "launch_frame",
        url,
      });
      expect(getMarketplaceShareData).not.toHaveBeenCalled();
    });
  }
  it("preserves normalized NFT/collection/order/source and reads trusted metadata only", async () => {
    vi.mocked(getMarketplaceShareData).mockResolvedValue({
      name: "Edição Gnars",
      image: "https://i.seadn.io/art.png",
      price: "0.02 ETH",
      source: "gnars-contract",
    });
    const collection = `0x${"22".repeat(20)}`;
    const order = `0x${"AB".repeat(32)}`;
    const metadata = await make("pt-br", {
      nft: "00054",
      collection,
      order,
      source: "gnars-contract",
      name: "Injected name",
      price: "99 ETH",
      image: "https://attacker.invalid/private",
    });
    const expected = `https://gnars.com/pt-br/marketplace?nft=54&collection=${collection}&order=${order.toLowerCase()}&source=gnars-contract`;
    const embed = JSON.parse(metadata.other!["fc:miniapp"] as string);
    expect(embed.button.action.url).toBe(expected);
    expect(embed.imageUrl).toBe(expected.replace("/marketplace?", "/marketplace/miniapp-image?"));
    expect(metadata.title).toBe("Edição Gnars | Gnars Marketplace");
    expect(metadata.openGraph).toMatchObject({ images: [{ width: 1200, height: 800 }] });
    expect(JSON.stringify(metadata)).not.toMatch(/Injected|attacker|99 ETH/);
  });
  it.each([
    { nft: "-1" },
    { nft: ["1", "2"] },
    { nft: "1", collection: "https://attacker.invalid" },
    { nft: "1", order: "0xbad", source: "gnars" },
  ])("invalid targets fall back without data requests: %o", async (query) => {
    const metadata = await make("en", query);
    expect(metadata.alternates?.canonical).toBe("https://gnars.com/marketplace");
    expect(getMarketplaceShareData).not.toHaveBeenCalled();
  });
  it("missing provider data keeps the NFT launch target but falls back to generic SEO", async () => {
    vi.mocked(getMarketplaceShareData).mockResolvedValue(null);
    const metadata = await make("pt-br", { nft: "54" });
    expect(metadata.title).toBe("Gnars Marketplace");
    expect(JSON.parse(metadata.other!["fc:miniapp"] as string).button.action.url).toBe(
      "https://gnars.com/pt-br/marketplace?nft=54",
    );
  });
});
