import { expect, test } from "@playwright/test";

const seller = "0x1111111111111111111111111111111111111111";
const offer = {
  id: "test-order",
  source: "opensea",
  orderHash: `0x${"11".repeat(32)}`,
  protocolAddress: "0x0000000000000068F116a894984e2DB1123eB395",
  seller,
  priceWei: "12300000000000000",
  currency: "ETH",
  expiresAt: 2100000000,
};
const item = {
  tokenId: "42",
  name: "Gnar #42",
  image: "/gnars.webp",
  owner: seller,
  offers: [offer],
};
const data = {
  items: [item],
  nextCursor: null,
  sources: {
    catalogue: { available: true },
    opensea: { available: true },
    gnars: { available: false, error: "not_configured" },
  },
  capabilities: { openseaBuy: false, localTrading: false },
};

for (const mobile of [false, true]) {
  test(`PT-BR marketplace browsing and unavailable trading ${mobile ? "mobile" : "desktop"}`, async ({
    page,
  }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    await page.route("**/api/marketplace**", (route) => route.fulfill({ json: data }));
    await page.goto("/pt-br/marketplace", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Gnars Marketplace", exact: true }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "À venda", exact: true }).click();
    await expect(page.getByRole("button", { name: "Ver Gnar #42", exact: true })).toBeVisible();
    await expect(page.getByText("0.0123 ETH", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole("button", { name: "Ver Gnar #42", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Gnar #42", exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Comprar", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("link", { name: "Ver na OpenSea" })).toHaveAttribute(
      "href",
      /opensea\.io\/item\/base\/0x880fb3cf5c6cc2d7dfc13a993e839a9411200c17\/42/i,
    );
    await expect(dialog.getByRole("link", { name: seller })).toHaveAttribute(
      "href",
      `/pt-br/members/${seller}`,
    );
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await page.getByRole("tab", { name: "Meus Gnars", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Conecte sua carteira", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Nenhum Gnar encontrado nesta carteira.")).not.toBeVisible();
  });
}

test("provider failure is not rendered as an empty successful marketplace", async ({ page }) => {
  await page.route("**/api/marketplace**", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
  await page.goto("/marketplace", { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "For sale", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Couldn't load" })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByText("No active listings found.")).not.toBeVisible();
});
