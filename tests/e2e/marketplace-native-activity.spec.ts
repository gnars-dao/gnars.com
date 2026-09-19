import { expect, test } from "@playwright/test";

test.setTimeout(90000);
const collection = "0x2222222222222222222222222222222222222222";
const seller = "0x1111111111111111111111111111111111111111";
const buyer = "0x3333333333333333333333333333333333333333";
const identity = { collectionAddress: collection, tokenId: "42" };
const item = {
  ...identity,
  name: "Native artwork",
  collectionName: "Community",
  image: "/gnars.webp",
  owner: seller,
  offers: [],
};
const sale = {
  id: "native:1",
  type: "sale",
  source: "gnars-contract",
  transactionHash: `0x${"ab".repeat(32)}`,
  timestamp: 1700000000,
  from: seller,
  to: buyer,
  payment: {
    quantity: "2000000000000000",
    decimals: 18,
    symbol: "ETH",
    tokenAddress: `0x${"00".repeat(20)}`,
  },
};

for (const width of [390, 1440]) {
  test(`expired activity cursor restarts history at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 950 });
    const cursors: Array<string | null> = [];
    await page.route("**/api/marketplace**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/traits"))
        return route.fulfill({ json: { ...identity, source: "tokenURI", traits: [] } });
      if (url.pathname.endsWith("/activity")) {
        const cursor = url.searchParams.get("cursor");
        cursors.push(cursor);
        if (cursor)
          return route.fulfill({
            status: 409,
            json: { error: "Expired", code: "ACTIVITY_CURSOR_EXPIRED", retryable: false },
          });
        return route.fulfill({
          json: {
            ...identity,
            source: "combined",
            sources: { gnars: { available: true }, opensea: { available: true } },
            events: [sale],
            nextCursor: cursors.length === 1 ? "expired" : null,
          },
        });
      }
      if (url.pathname.endsWith("/community"))
        return route.fulfill({ json: { items: [item], nextCursor: null, available: true } });
      return route.fulfill({
        json: {
          items: [item],
          nextCursor: null,
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
        },
      });
    });
    await page.goto(`/pt-br/marketplace?collection=${collection}&nft=42`, {
      waitUntil: "domcontentloaded",
    });
    const drawer = page.getByRole("dialog");
    await drawer.getByRole("tab", { name: "Atividade", exact: true }).click();
    await drawer.getByRole("button", { name: "Carregar mais atividade", exact: true }).click();
    await expect(drawer.getByRole("alert")).toContainText("O histórico mudou");
    await expect(drawer.getByText("0.002 ETH", { exact: true })).toBeVisible();
    await expect(
      drawer.getByRole("button", { name: "Carregar mais atividade", exact: true }),
    ).toHaveCount(0);
    expect(cursors).toEqual([null, "expired"]);
    await drawer.getByRole("button", { name: "Tentar novamente", exact: true }).click();
    await expect(drawer.getByRole("alert")).toHaveCount(0);
    await expect(drawer.getByText("0.002 ETH", { exact: true })).toBeVisible();
    expect(cursors).toEqual([null, "expired", null]);
  });
  test(`combined activity preserves native sales during partial failure at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    let partial = false;
    let empty = true;
    await page.route("**/api/marketplace**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/traits"))
        return route.fulfill({ json: { ...identity, source: "tokenURI", traits: [] } });
      if (url.pathname.endsWith("/activity"))
        return route.fulfill({
          json: {
            ...identity,
            source: "combined",
            nextCursor: partial || empty ? "next" : null,
            sources: { gnars: { available: true }, opensea: { available: !partial } },
            coverage: { startBlock: "1", indexedThrough: "42", blockHash: sale.transactionHash },
            events: empty
              ? []
              : [
                  sale,
                  { ...sale, id: "provider", source: "opensea" },
                  { ...sale, id: "transfer", type: "transfer", source: "opensea" },
                ],
          },
        });
      if (url.pathname.endsWith("/community"))
        return route.fulfill({ json: { items: [item], nextCursor: null, available: true } });
      return route.fulfill({
        json: {
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
        },
      });
    });
    await page.goto(`/pt-br/marketplace?collection=${collection}&nft=42`, {
      waitUntil: "domcontentloaded",
    });
    const drawer = page.getByRole("dialog");
    await drawer.getByRole("tab", { name: "Atividade", exact: true }).click();
    await expect(
      drawer.getByRole("link", { name: "Gnars indexado até o bloco 42", exact: true }),
    ).toHaveAttribute("href", "https://basescan.org/block/42");
    await expect(
      drawer.getByRole("button", { name: "Carregar mais atividade", exact: true }),
    ).toBeVisible();
    await expect(
      drawer.getByText("Nenhuma atividade indexada encontrada.", { exact: true }),
    ).toHaveCount(0);
    partial = true;
    await drawer.getByRole("button", { name: "Carregar mais atividade", exact: true }).click();
    await expect(drawer.getByRole("alert")).toContainText("Fonte indisponível: OpenSea");
    await expect(
      drawer.getByText("Nenhuma atividade indexada encontrada.", { exact: true }),
    ).toHaveCount(0);
    empty = false;
    await drawer.getByRole("button", { name: "Tentar novamente", exact: true }).click();
    await expect(drawer.getByText("0.002 ETH", { exact: true })).toBeVisible();
    await expect(drawer.getByText("Contrato Gnars · onchain", { exact: true })).toBeVisible();
    await expect(drawer.getByRole("link", { name: "Transação", exact: true })).toHaveCount(1);
    await expect(drawer.getByRole("alert")).toContainText("Histórico incompleto");
    partial = false;
    await drawer.getByRole("button", { name: "Carregar mais atividade", exact: true }).click();
    await expect(drawer.getByRole("alert")).toHaveCount(0);
    await expect(drawer.getByRole("link", { name: "Transação", exact: true })).toHaveCount(1);
    await drawer.getByRole("link", { name: "Transação", exact: true }).scrollIntoViewIfNeeded();
    await expect
      .poll(async () => {
        const bounds = await drawer.boundingBox();
        const title = await drawer.locator('[data-slot="drawer-title"]').boundingBox();
        return (
          !!bounds &&
          !!title &&
          title.y >= bounds.y &&
          title.y + title.height <= bounds.y + bounds.height
        );
      })
      .toBe(true);
    expect(await drawer.evaluate((element) => element.scrollTop)).toBe(0);
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
      path: `test-results/marketplace-native-activity-${width}.png`,
      fullPage: false,
      animations: "disabled",
    });
  });
}
