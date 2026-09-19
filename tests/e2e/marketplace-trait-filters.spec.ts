import { expect, test } from "@playwright/test";

test.setTimeout(90000);
const snapshotId = `0x${"ab".repeat(32)}`;
const collectionAddress = "0x880fb3cf5c6cc2d7dfc13a993e839a9411200c17";
const item = {
  tokenId: "42",
  name: "Gnar #42",
  image: "/gnars.webp",
  owner: "0x1111111111111111111111111111111111111111",
  offers: [],
};
for (const width of [390, 1440]) {
  test(`trait filters survive price changes and reload at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 950 });
    await page.addInitScript(() => localStorage.setItem("theme", "dark"));
    const reads: URL[] = [];
    let failed = true;
    await page.route("**/api/marketplace**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("trait-facets"))
        return failed
          ? route.fulfill({ status: 503, json: { error: "Unavailable" } })
          : route.fulfill({
              json: {
                snapshotId,
                collectionAddress,
                blockNumber: "100",
                total: 6006,
                traits: [
                  {
                    type: "3-heads",
                    values: [
                      { value: "mirror", count: 22 },
                      { value: "calendar", count: 12 },
                    ],
                  },
                ],
              },
            });
      if (url.pathname.endsWith("/community"))
        return route.fulfill({ json: { items: [], nextCursor: null, available: true } });
      if (url.pathname === "/api/marketplace") reads.push(url);
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
          },
        },
      });
    });
    await page.goto("/pt-br/marketplace", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Traços dos Gnars", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "traços" })).toBeVisible();
    failed = false;
    await page.getByRole("button", { name: "Tentar novamente", exact: true }).click();
    await page.locator("summary").filter({ hasText: "3-heads" }).click();
    await page.getByRole("checkbox", { name: /mirror/ }).check();
    await expect
      .poll(() =>
        reads.some(
          (url) =>
            url.searchParams.get("traits") === '{"3-heads":["mirror"]}' &&
            url.searchParams.get("traitSnapshot") === snapshotId,
        ),
      )
      .toBe(true);
    await page.getByLabel("Preço mín. (ETH)", { exact: true }).fill("0.001");
    await page.getByRole("button", { name: "Aplicar", exact: true }).click();
    await expect
      .poll(() =>
        reads.some(
          (url) =>
            url.searchParams.has("traits") &&
            url.searchParams.get("minPriceWei") === "1000000000000000",
        ),
      )
      .toBe(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /Traços dos Gnars/ }).click();
    await page.locator("summary").filter({ hasText: "3-heads" }).click();
    await expect(page.getByRole("checkbox", { name: /mirror/ })).toBeChecked();
    await page.screenshot({
      path: `test-results/trait-filters-${width}.png`,
      animations: "disabled",
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole("button", { name: "Limpar filtros de traços", exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.has("traits")).toBe(false);
    expect(new URL(page.url()).searchParams.get("minPriceWei")).toBe("1000000000000000");
  });
}
