import { expect, test } from "@playwright/test";

test.setTimeout(90000);
const seller = "0x1111111111111111111111111111111111111111";
const contract = "0xC35813d40961151c11C97cB9d67D0D25CD4Cc86e";
const base = {
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
function item(id: string, nativePrice: string, externalPrice: string) {
  return {
    tokenId: id,
    name: `Gnar #${id}`,
    image: "/gnars.webp",
    owner: seller,
    offers: ["gnars-contract", "opensea"].map((source, index) => ({
      source,
      id: `${id}-${source}`,
      protocolAddress: contract,
      orderHash: `0x${(Number(id) + index).toString(16).padStart(2, "0").repeat(32)}`,
      seller,
      priceWei: index ? externalPrice : nativePrice,
      currency: "ETH",
      expiresAt: 2100000000,
    })),
  };
}

for (const width of [390, 1440]) {
  test(`price range applies to both feeds and restores at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const requests: URL[] = [];
    await page.route("**/api/marketplace**", (route) => {
      const url = new URL(route.request().url());
      requests.push(url);
      const filtered = url.searchParams.has("minPriceWei");
      if (url.pathname === "/api/marketplace/community")
        return route.fulfill({ json: { items: [], nextCursor: null, available: true } });
      return route.fulfill({
        json: {
          ...base,
          items: filtered
            ? [item("2", "20000000000000000", "30000000000000000")]
            : url.searchParams.has("cursor")
              ? [item("3", "40000000000000000", "40000000000000000")]
              : [
                  item("1", "10000000000000000", "30000000000000000"),
                  item("2", "20000000000000000", "10000000000000000"),
                ],
          nextCursor: !filtered && !url.searchParams.has("cursor") ? "next-page" : null,
        },
      });
    });
    await page.goto("/pt-br/marketplace", { waitUntil: "domcontentloaded" });
    const native = page.locator("section[aria-labelledby='sale-band-native']");
    const external = page.locator("section[aria-labelledby='sale-band-opensea']");
    await expect(native.getByRole("button", { name: /^Ver Gnar/ }).first()).toHaveAccessibleName(
      "Ver Gnar #1",
    );
    await expect(external.getByRole("button", { name: /^Ver Gnar/ }).first()).toHaveAccessibleName(
      "Ver Gnar #2",
    );
    await page.getByRole("button", { name: "Carregar mais", exact: true }).click();
    await expect(native.getByRole("button", { name: "Ver Gnar #3", exact: true })).toBeVisible();
    const min = page.getByLabel("Preço mín. (ETH)", { exact: true });
    const max = page.getByLabel("Preço máx. (ETH)", { exact: true });
    await min.fill("0,02");
    await max.fill("0.03");
    await page.getByRole("button", { name: "Aplicar", exact: true }).click();
    await expect(native.getByRole("button", { name: "Ver Gnar #1", exact: true })).toHaveCount(0);
    await expect(native.getByRole("button", { name: "Ver Gnar #3", exact: true })).toHaveCount(0);
    await expect(native.getByRole("button", { name: "Ver Gnar #2", exact: true })).toBeVisible();
    await expect
      .poll(() =>
        ["/api/marketplace", "/api/marketplace/community"].every((path) =>
          requests.some(
            (url) =>
              url.pathname === path &&
              url.searchParams.get("sort") === "price-asc" &&
              url.searchParams.get("minPriceWei") === "20000000000000000" &&
              url.searchParams.get("maxPriceWei") === "30000000000000000" &&
              !url.searchParams.has("cursor"),
          ),
        ),
      )
      .toBe(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(min).toHaveValue("0.02");
    await expect(max).toHaveValue("0.03");
    await expect(native.getByRole("button", { name: "Ver Gnar #2", exact: true })).toBeVisible();
    await min.fill("0.04");
    await page.getByRole("button", { name: "Aplicar", exact: true }).click();
    await expect(page.locator("#market-price-error")).toBeVisible();
    await expect(native.getByRole("button", { name: "Ver Gnar #2", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Limpar", exact: true }).click();
    await expect(min).toHaveValue("");
    await expect(max).toHaveValue("");
    await expect(native.getByRole("button", { name: "Ver Gnar #1", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `/tmp/marketplace-price-filters-${width}.png`, fullPage: true });
  });
}

test("empty intermediate community page retains continuation and active bounds", async ({
  page,
}) => {
  await page.route("**/api/marketplace**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/marketplace/community") {
      const next = url.searchParams.get("cursor") === "continue";
      expect(url.searchParams.get("minPriceWei")).toBe("1");
      return route.fulfill({
        json: {
          available: true,
          items: next
            ? [
                {
                  ...item("5", "10000000000000000", "10000000000000000"),
                  collectionName: "Community",
                  collectionAddress: contract,
                },
              ]
            : [],
          nextCursor: next ? null : "continue",
        },
      });
    }
    return route.fulfill({ json: { ...base, items: [], nextCursor: null } });
  });
  await page.goto("/pt-br/marketplace?minPriceWei=1", { waitUntil: "domcontentloaded" });
  const community = page.locator("section[aria-labelledby='sale-band-community']");
  await expect(
    community.getByText("Nenhum anúncio ativo encontrado.", { exact: true }),
  ).toHaveCount(0);
  await community.getByRole("button", { name: "Carregar mais", exact: true }).click();
  await expect(community.getByRole("button", { name: "Ver Gnar #5", exact: true })).toBeVisible();
});
