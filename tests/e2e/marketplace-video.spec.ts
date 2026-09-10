import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const collection = "0x2222222222222222222222222222222222222222";
const item = {
  collectionAddress: collection,
  collectionName: "Gnars Community",
  tokenId: "42",
  name: "Sessão Gnars",
  image: "/gnars.webp",
  animationUrl: "https://media.example.com/nft.mp4",
  owner: "0x1111111111111111111111111111111111111111",
  offers: [
    {
      id: "video-order",
      source: "gnars-contract",
      orderHash: `0x${"11".repeat(32)}`,
      protocolAddress: "0xC35813d40961151c11C97cB9d67D0D25CD4Cc86e",
      seller: "0x1111111111111111111111111111111111111111",
      priceWei: "10000000000000000",
      currency: "ETH",
      expiresAt: 2100000000,
    },
  ],
};
const data = {
  ownershipVerified: true,
  items: [item],
  nextCursor: null,
  sources: {
    catalogue: { available: true },
    opensea: { available: true },
    gnars: { available: true },
  },
  capabilities: {
    openseaBuy: false,
    openseaSell: false,
    openseaCancel: false,
    localTrading: false,
    customTrading: false,
  },
};
async function setup(page: Page, unavailable = false) {
  await page.addInitScript(() => localStorage.setItem("theme", "dark"));
  await page.route("**/api/marketplace**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/marketplace/community")
      return route.fulfill({ json: { items: [item], nextCursor: null, available: true } });
    return route.fulfill({ json: { ...data, items: pathname.includes("/nfts/") ? [item] : [] } });
  });
  await page.route(item.animationUrl, (route) =>
    unavailable
      ? route.fulfill({ status: 503, body: "Unavailable" })
      : route.fulfill({
          path: path.resolve("tests/fixtures/nft-preview.mp4"),
          contentType: "video/mp4",
        }),
  );
  await page.goto("/pt-br/marketplace", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Atualizar anúncios", exact: true }).click();
  const card = page.getByRole("button", { name: `Ver ${item.name}`, exact: true });
  await expect(card).toBeVisible();
  await expect(card.locator("video")).toHaveCount(0);
  await expect(card.locator("img")).toBeVisible();
  await card.click();
  return page.getByRole("dialog");
}

test.setTimeout(90000);
for (const width of [1440, 390]) {
  test(`NFT video plays only in detail, keeps cover cards ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const dialog = await setup(page);
    const video = dialog.locator("video");
    await expect(video).toBeVisible();
    await expect(video).toHaveAttribute("controls", "");
    await expect(video).toHaveAttribute("playsinline", "");
    await expect(video).not.toHaveAttribute("autoplay", "");
    await expect(video).toHaveAttribute("poster", item.image);
    expect(await video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
    await video.evaluate((node: HTMLVideoElement) => node.play());
    await expect
      .poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime))
      .toBeGreaterThan(0.2);
    expect(await video.evaluate((node: HTMLVideoElement) => node.videoWidth)).toBe(320);
    await video.evaluate((node: HTMLVideoElement) => node.pause());
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `/tmp/marketplace-video-${width}.png`, fullPage: true });
    await dialog.getByRole("button", { name: "Fechar", exact: true }).click();
    await expect(page.locator("video")).toHaveCount(0);
  });
}

test("NFT video failure keeps the cover and listing details", async ({ page }) => {
  const dialog = await setup(page, true);
  const video = dialog.locator("video");
  await expect(video).toBeVisible();
  await video.evaluate((node: HTMLVideoElement) => {
    void node.play().catch(() => {});
  });
  await expect(dialog.getByRole("status")).toContainText("vídeo");
  await expect(dialog.locator("video")).toHaveCount(0);
  await expect(dialog.getByRole("img", { name: item.name, exact: true })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: item.name, exact: true })).toBeVisible();
});
