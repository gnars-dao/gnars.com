import { expect, test } from "@playwright/test";
import { SEAPORT_ADDRESS } from "../../src/lib/marketplace/routing";

for (const width of [390, 1440]) {
  test(`dual-listed NFT selects one exact offer at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const offer = {
      id: "native",
      source: "gnars-contract",
      protocolAddress: "0xC35813d40961151c11C97cB9d67D0D25CD4Cc86e",
      orderHash: `0x${"01".repeat(32)}`,
      seller: "0x2222222222222222222222222222222222222222",
      priceWei: "20000000000000000",
      currency: "ETH",
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
    };
    const payload = {
      items: [
        {
          tokenId: "42",
          name: "Gnar #42",
          image: "/gnars.webp",
          owner: offer.seller,
          offers: [
            offer,
            {
              ...offer,
              id: "external",
              source: "opensea",
              protocolAddress: SEAPORT_ADDRESS,
              orderHash: `0x${"02".repeat(32)}`,
              priceWei: "10000000000000000",
            },
          ],
        },
      ],
      nextCursor: null,
      sources: {
        catalogue: { available: true },
        opensea: { available: true },
        gnars: { available: true },
        "gnars-contract": { available: true },
      },
      capabilities: {
        openseaBuy: true,
        openseaSell: true,
        openseaCancel: true,
        localTrading: true,
        customTrading: true,
      },
    };
    await page.route("**/api/marketplace**", (route) => {
      const url = new URL(route.request().url());
      return route.fulfill({
        json:
          url.pathname === "/api/marketplace/community"
            ? { items: [], available: true, nextCursor: null }
            : payload,
      });
    });
    await page.goto("/pt-br/marketplace", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Atualizar anúncios", exact: true }).click();
    const native = page
      .locator("section[aria-labelledby='sale-band-native']")
      .getByRole("checkbox");
    const external = page
      .locator("section[aria-labelledby='sale-band-opensea']")
      .getByRole("checkbox");
    await expect(native).toHaveCount(1);
    await expect(external).toHaveCount(1);
    await native.check();
    await expect(native).toBeChecked();
    await expect(external).not.toBeChecked();
    await external.check();
    await expect(external).toBeChecked();
    await expect(native).not.toBeChecked();
    await native.check();
    await expect(native).toBeChecked();
    await expect(external).not.toBeChecked();
    await page.screenshot({
      path: `/tmp/marketplace-sweep-selection-${width}.png`,
      fullPage: true,
    });
    await native.uncheck();
    await expect(native).not.toBeChecked();
    await expect(external).not.toBeChecked();
    payload.capabilities.customTrading = false;
    await page.getByRole("button", { name: "Atualizar anúncios", exact: true }).click();
    await expect(native).toHaveCount(0);
    await expect(external).toHaveCount(1);
    await external.check();
    await expect(page.getByRole("button", { name: "Revisar lote", exact: true })).toBeVisible();
    await external.uncheck();
    payload.capabilities.customTrading = true;
    payload.capabilities.openseaBuy = false;
    await page.getByRole("button", { name: "Atualizar anúncios", exact: true }).click();
    await expect(native).toHaveCount(1);
    await expect(external).toHaveCount(0);
    await native.check();
    await expect(page.getByRole("button", { name: "Revisar lote", exact: true })).toBeVisible();
  });
}
