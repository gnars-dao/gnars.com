import { expect, test } from "@playwright/test";

test.setTimeout(90000);
const collection = "0x2222222222222222222222222222222222222222";
const seller = "0x1111111111111111111111111111111111111111";
const buyer = "0x3333333333333333333333333333333333333333";
const identity = { collectionAddress: collection, tokenId: "42" };
const item = {
  ...identity,
  name: "Insight artwork",
  collectionName: "Community",
  image: "/gnars.webp",
  owner: seller,
  offers: [],
};
const base = {
  items: [item],
  nextCursor: null,
  ownershipVerified: true,
  sources: {
    catalogue: { available: true },
    opensea: { available: true },
    gnars: { available: true },
  },
  capabilities: {
    openseaBuy: true,
    openseaSell: true,
    openseaCancel: true,
    localTrading: true,
    customTrading: true,
  },
};
const movement = {
  id: "transfer",
  type: "transfer",
  transactionHash: `0x${"ab".repeat(32)}`,
  timestamp: 1700000000,
  from: seller,
  to: buyer,
};

for (const width of [390, 1440]) {
  test(`NFT insights: lazy history, retry and pagination at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 950 });
    let requests = 0;
    let fail = true;
    await page.route("**/api/marketplace**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/traits"))
        return route.fulfill({
          json: {
            ...identity,
            source: "tokenURI",
            traits: [{ type: "Background", value: "Yellow" }],
          },
        });
      if (url.pathname.endsWith("/activity")) {
        requests++;
        if (fail) return route.fulfill({ status: 503, json: { error: "Unavailable" } });
        const second = url.searchParams.has("cursor");
        return route.fulfill({
          json: {
            ...identity,
            source: "opensea",
            nextCursor: second ? null : "next",
            events: [
              second
                ? {
                    ...movement,
                    id: "sale",
                    type: "sale",
                    payment: {
                      quantity: "1300000000000000",
                      decimals: 18,
                      symbol: "WETH",
                      tokenAddress: "0x4200000000000000000000000000000000000006",
                    },
                  }
                : movement,
            ],
          },
        });
      }
      if (url.pathname === "/api/marketplace/community")
        return route.fulfill({ json: { items: [item], nextCursor: null, available: true } });
      return route.fulfill({ json: base });
    });
    await page.goto(`/pt-br/marketplace?collection=${collection}&nft=42`, {
      waitUntil: "domcontentloaded",
    });
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByRole("tab", { name: "Características" })).toBeVisible();
    await expect(drawer.getByText("Yellow", { exact: true })).toBeVisible();
    expect(requests).toBe(0);
    await drawer.getByRole("tab", { name: "Atividade", exact: true }).click();
    await expect(drawer.getByRole("alert")).toContainText("atividade");
    fail = false;
    await drawer.getByRole("button", { name: "Tentar novamente", exact: true }).click();
    await expect(drawer.getByRole("link", { name: "Transação", exact: true })).toHaveCount(1);
    await drawer.getByRole("button", { name: "Carregar mais atividade", exact: true }).click();
    await expect(drawer.getByText("0.0013 WETH", { exact: true })).toBeVisible();
    await expect(drawer.getByRole("link", { name: "Transação", exact: true })).toHaveCount(1);
    await expect(drawer.locator(`a[href$='/members/${buyer}']`)).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect
      .poll(async () => {
        const bounds = await drawer.boundingBox();
        return !!bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1;
      })
      .toBe(true);
    await page.screenshot({
      path: `test-results/marketplace-insights-${width}.png`,
      fullPage: false,
      animations: "disabled",
    });
  });
}
