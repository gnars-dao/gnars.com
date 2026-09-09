import { expect, test, type Page } from "@playwright/test";
import type { SwapTokenDirectory } from "../../src/lib/swap-token-directory";

const zoraAddress = "0x1111111111111111111111111111111111111111";
const clankerAddress = "0x2222222222222222222222222222222222222222";
const stockAddress = "0x3333333333333333333333333333333333333333";
const morAddress = "0x7431ada8a591c955a994a21710752ef9b882b8e3";
const longSymbol = "CREATORCOINWITHANEXTREMELYLONGSYMBOLTHATCANNOTRESIZETHEROW";
const directory: SwapTokenDirectory = {
  tokens: [
    {
      address: zoraAddress,
      symbol: longSymbol,
      name: "A very long creator name with enough words to exceed the available token row width",
      decimals: 18,
      category: "creator",
      source: "zora",
      logo: "/gnars.webp",
    },
    {
      address: clankerAddress,
      symbol: "CLANK",
      name: "Clanker test creator",
      decimals: 18,
      category: "creator",
      source: "clanker",
    },
    {
      address: stockAddress,
      symbol: "STOCKtest",
      name: "Tokenized stock fixture with a deliberately long issuer name",
      decimals: 18,
      category: "stock",
      source: "ondo",
    },
  ],
  sources: { zora: { available: true }, clanker: { available: true }, stocks: { available: true } },
};

async function setup(page: Page, data = directory) {
  const requests = { directory: 0, lookup: 0, externalZora: 0 };
  await page.route("**/api/swap/tokens?**", (route) => {
    requests.directory += 1;
    return route.fulfill({ json: data });
  });
  await page.route("**/api/coins/meta?**", (route) =>
    route.fulfill({ json: { coin: null, source: null } }),
  );
  await page.route("**/api/wallet/token-lookup?**", (route) => {
    requests.lookup += 1;
    return route.fulfill({ status: 503, json: { error: "Unavailable" } });
  });
  await page.route("**://api-sdk.zora.engineering/**", (route) => {
    requests.externalZora += 1;
    return route.abort();
  });
  await page.goto("/pt-br/swap", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Token de venda", exact: true })).toBeVisible();
  return requests;
}

async function openPicker(page: Page, side: "venda" | "compra" = "venda") {
  const trigger = page.getByRole("button", { name: `Token de ${side}`, exact: true });
  // Allow a streamed SSR click to be retried only after waiting for React to open the dialog.
  await expect(async () => {
    if (!(await page.getByTestId("token-picker").isVisible())) await trigger.click();
    await expect(page.getByTestId("token-picker")).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 15000, intervals: [1000] });
  return page.getByTestId("token-picker");
}

test("PT-BR dark picker contains long rows at 320px and desktop", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("theme", "dark"));
  await page.setViewportSize({ width: 320, height: 568 });
  await setup(page);
  const picker = await openPicker(page);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await picker.getByRole("tab", { name: "Criadores", exact: true }).click();
  await expect(picker.locator(`[data-token-address="${zoraAddress}"]`)).toBeVisible();
  expect(await picker.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const bounds = await picker.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  await expect(picker.getByRole("button", { name: "Fechar seletor de tokens" })).toBeInViewport();
  for (const row of await picker
    .getByTestId("token-column-creator")
    .getByTestId("token-picker-row")
    .all()) {
    expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await page.screenshot({ path: "test-results/swap-token-picker-dark-320.png" });
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const group of ["wallet", "creator", "stock"])
    await expect(picker.getByTestId(`token-column-${group}`)).toBeVisible();
  await page.screenshot({ path: "test-results/swap-token-picker-dark-desktop.png" });
});

test("selected long symbol keeps the swap amount and controls inside 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await setup(page);
  const picker = await openPicker(page);
  await picker.getByRole("tab", { name: "Criadores", exact: true }).click();
  await picker.locator(`[data-token-address="${zoraAddress}"]`).click();
  await expect(picker).not.toBeVisible();
  const trigger = page.getByRole("button", { name: "Token de venda", exact: true });
  await expect(trigger).toContainText(directory.tokens[0].name);
  const amount = page.getByRole("spinbutton", { name: "Quantia de venda", exact: true });
  const symbol = page.locator(`span[title="${longSymbol}"]`);
  await expect(symbol).toHaveText(longSymbol);
  const action = page.getByRole("button", { name: "Conectar wallet para fazer swap", exact: true });
  for (const element of [trigger, amount, symbol, action]) {
    await element.scrollIntoViewIfNeeded();
    const bounds = await element.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.width).toBeGreaterThan(0);
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(321);
  }
  const amountBox = await amount.boundingBox();
  const symbolBox = await symbol.boundingBox();
  expect(amountBox!.x + amountBox!.width).toBeLessThanOrEqual(symbolBox!.x + 1);
  await amount.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/swap-selected-long-symbol-320.png" });
});

for (const mobile of [false, true]) {
  test(`PT-BR token categories, long labels and shared requests ${mobile ? "mobile" : "desktop"}`, async ({
    page,
  }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    const requests = await setup(page);
    expect(requests.directory).toBe(0);
    const picker = await openPicker(page);
    const wallet = picker.getByTestId("token-column-wallet");
    const creator = picker.getByTestId("token-column-creator");
    const stock = picker.getByTestId("token-column-stock");
    await expect(wallet).toBeVisible();
    await expect.poll(() => requests.directory).toBe(1);
    if (mobile) {
      await expect(creator).not.toBeVisible();
      await expect(stock).not.toBeVisible();
      await picker.getByRole("tab", { name: "Criadores", exact: true }).click();
    } else {
      const boxes = await Promise.all(
        [wallet, creator, stock].map((column) => column.boundingBox()),
      );
      expect(boxes.every(Boolean)).toBe(true);
      expect(boxes[0]!.x + boxes[0]!.width).toBeLessThanOrEqual(boxes[1]!.x + 1);
      expect(boxes[1]!.x + boxes[1]!.width).toBeLessThanOrEqual(boxes[2]!.x + 1);
    }
    await expect(creator.locator(`[data-token-address="${zoraAddress}"]`)).toBeVisible();
    await expect(creator.locator(`[data-token-address="${clankerAddress}"]`)).toBeVisible();
    expect(await picker.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    for (const row of await picker.getByTestId("token-picker-row").all()) {
      if (await row.isVisible())
        expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
    }
    await page.screenshot({
      path: `test-results/swap-token-picker-${mobile ? "mobile" : "desktop"}.png`,
    });
    await creator.getByRole("button", { name: "Clanker", exact: true }).click();
    await expect(creator.locator(`[data-token-address="${zoraAddress}"]`)).toHaveCount(0);
    await expect(creator.locator(`[data-token-address="${clankerAddress}"]`)).toBeVisible();
    await creator.getByRole("button", { name: "Todos", exact: true }).click();
    const search = picker.getByRole("textbox", { name: "Buscar nome ou colar endereço" });
    await search.fill(zoraAddress.toUpperCase().replace("0X", "0x"));
    await expect(creator.getByTestId("token-picker-row")).toHaveCount(1);
    await expect(creator.getByText(longSymbol, { exact: true })).toBeVisible();
    await picker.getByRole("button", { name: "Limpar busca", exact: true }).click();
    if (mobile) await picker.getByRole("tab", { name: "Ações", exact: true }).click();
    await expect(stock.locator(`[data-token-address="${stockAddress}"]`)).toBeVisible();
    await stock.locator(`[data-token-address="${stockAddress}"]`).click();
    await expect(picker).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Token de venda", exact: true })).toContainText(
      directory.tokens[2].name,
    );
    await openPicker(page, "compra");
    if (mobile) await picker.getByRole("tab", { name: "Ações", exact: true }).click();
    await expect(stock.locator(`[data-token-address="${stockAddress}"]`)).toBeDisabled();
    if (mobile) await picker.getByRole("tab", { name: "Carteira", exact: true }).click();
    await expect(wallet.locator(`[data-token-address="${morAddress}"]`)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(requests.directory).toBe(1);
    expect(requests.lookup).toBe(0);
    expect(requests.externalZora).toBe(0);
    await page.keyboard.press("Escape");
    await expect(picker).not.toBeVisible();
  });
}

test("partial catalogue failure preserves known rows and offers retry", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const requests = await setup(page, {
    ...directory,
    sources: { ...directory.sources, clanker: { available: false } },
  });
  const picker = await openPicker(page);
  const creator = picker.getByTestId("token-column-creator");
  await expect(creator.getByRole("status")).toContainText("Parte do catálogo está indisponível");
  await expect(creator.locator(`[data-token-address="${zoraAddress}"]`)).toBeVisible();
  await creator.getByRole("button", { name: "Tentar carregar tokens novamente" }).click();
  await expect.poll(() => requests.directory).toBe(2);
  expect(requests.externalZora).toBe(0);
});

test("mobile keyboard category navigation and failed address lookup preserve the picker", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 640 });
  const requests = await setup(page);
  const picker = await openPicker(page);
  const walletTab = picker.getByRole("tab", { name: "Carteira", exact: true });
  await walletTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(picker.getByRole("tab", { name: "Criadores", exact: true })).toBeFocused();
  await expect(picker.getByTestId("token-column-creator")).toBeVisible();
  await page.keyboard.press("End");
  await expect(picker.getByRole("tab", { name: "Ações", exact: true })).toBeFocused();
  await picker.getByRole("textbox").fill("0x4444444444444444444444444444444444444444");
  await expect(picker.getByRole("alert")).toContainText("Consulta de token indisponível");
  expect(requests.lookup).toBe(1);
  await expect(picker.getByRole("button", { name: "Fechar seletor de tokens" })).toBeInViewport();
  expect(await picker.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});
