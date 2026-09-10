import { expect, test, type Page } from "@playwright/test";
import { VERIFIED_BASE_STOCK_TOKENS } from "../../src/data/swap-stock-tokens";

const nvidia = VERIFIED_BASE_STOCK_TOKENS.find((token) => token.symbol === "NVDAc")!;
const creator = {
  address: "0x1111111111111111111111111111111111111111",
  symbol: "CREATORWITHAVERYLONGSYMBOLTHATMUSTNOTOVERFLOW",
  name: "A creator name with enough words to test the narrow mobile card",
  decimals: 18,
  category: "creator",
  source: "zora",
  logo: "/gnars.webp",
};
const clanker = {
  ...creator,
  address: "0x2222222222222222222222222222222222222222",
  name: "Clanker creator",
  symbol: "CLANK",
  source: "clanker",
};

async function openPicker(page: Page, side: "venda" | "compra") {
  const picker = page.getByTestId("token-picker");
  await expect(async () => {
    if (!(await picker.isVisible()))
      await page.getByRole("button", { name: `Token de ${side}`, exact: true }).click();
    await expect(picker).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 15000 });
  return picker;
}

for (const mobile of [false, true]) {
  test(`token cards preserve provenance and artwork ${mobile ? "mobile" : "desktop"}`, async ({
    page,
  }) => {
    await page.setViewportSize(
      mobile ? { width: 320, height: 740 } : { width: 1440, height: 1100 },
    );
    await page.addInitScript(() => localStorage.setItem("theme", "dark"));
    const metadataRequests: string[] = [];
    await page.route("**/api/swap/tokens?**", (route) =>
      route.fulfill({
        json: {
          tokens: [nvidia, creator, clanker],
          sources: {
            zora: { available: true },
            clanker: { available: true },
            stocks: { available: true },
          },
        },
      }),
    );
    await page.route("**/api/coins/meta?**", (route) => {
      const address = new URL(route.request().url()).searchParams.get("address")!;
      metadataRequests.push(address);
      return route.fulfill({
        json: {
          source: "zora",
          coin: {
            address,
            name: creator.name,
            symbol: creator.symbol,
            creatorProfile: { handle: "testcreator" },
            mediaContent: { originalUri: "/gnars.webp" },
            marketCap: "1100",
            marketCapDelta24h: "100",
            volume24h: "300",
            uniqueHolders: 10,
          },
        },
      });
    });
    await page.goto("/pt-br/swap", { waitUntil: "domcontentloaded" });
    const cards = page.getByTestId("swap-token-card");
    await expect(cards).toHaveCount(2);
    const sell = page.locator('[data-testid="swap-token-card"][data-side="sell"]');
    const buy = page.locator('[data-testid="swap-token-card"][data-side="buy"]');
    await expect(sell).toHaveAttribute("data-token-kind", "native");
    await expect(buy).toHaveAttribute("data-token-kind", "token");
    await expect(cards.getByRole("link", { name: "Ver na Zora" })).toHaveCount(0);
    expect(metadataRequests).toEqual([]);

    let picker = await openPicker(page, "compra");
    if (mobile) await picker.getByRole("tab", { name: "Ações", exact: true }).click();
    await picker.locator(`[data-token-address="${nvidia.address.toLowerCase()}"]`).click();
    await expect(picker).not.toBeVisible();
    await expect(buy).toHaveAttribute("data-token-kind", "stock");
    await expect(buy).toContainText("Ação tokenizada");
    await expect(buy.getByRole("img", { name: "NVIDIA Corporation" })).toHaveAttribute(
      "src",
      nvidia.logo!,
    );
    await expect(buy.getByRole("link")).toHaveAttribute(
      "href",
      new RegExp(`basescan.org/token/${nvidia.address}`, "i"),
    );
    await expect(buy.getByRole("link", { name: "Ver na Zora" })).toHaveCount(0);
    expect(metadataRequests).toEqual([]);

    picker = await openPicker(page, "venda");
    if (mobile) await picker.getByRole("tab", { name: "Criadores", exact: true }).click();
    await picker.locator(`[data-token-address="${creator.address}"]`).click();
    await expect(sell).toContainText("@testcreator");
    await expect(sell.getByRole("link", { name: "Ver na Zora" })).toHaveAttribute(
      "href",
      `https://zora.co/coin/base:${creator.address}`,
    );
    await expect
      .poll(() => sell.getByRole("img").evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    if (!mobile) {
      const sellBounds = await sell.boundingBox();
      const buyBounds = await buy.boundingBox();
      expect(sellBounds!.width).toBeLessThan(600);
      expect(buyBounds!.x).toBeGreaterThan(sellBounds!.x + sellBounds!.width);
      expect(Math.abs(buyBounds!.y - sellBounds!.y)).toBeLessThan(2);
    }
    for (const card of await cards.all()) {
      await card.scrollIntoViewIfNeeded();
      expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      const bounds = await card.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(mobile ? 321 : 1441);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: `test-results/swap-token-cards-${mobile ? "mobile" : "desktop"}.png`,
      fullPage: true,
    });
    expect(metadataRequests).toEqual([creator.address]);

    picker = await openPicker(page, "venda");
    if (mobile) await picker.getByRole("tab", { name: "Criadores", exact: true }).click();
    await picker.locator(`[data-token-address="${clanker.address}"]`).click();
    await expect(sell).toHaveAttribute("data-token-kind", "clanker");
    await expect(sell.getByRole("link", { name: "Ver na Clanker" })).toHaveAttribute(
      "href",
      `https://www.clanker.world/clanker/${clanker.address}`,
    );
    await expect(sell.getByText("@testcreator")).toHaveCount(0);
    expect(metadataRequests).toEqual([creator.address]);
  });
}
