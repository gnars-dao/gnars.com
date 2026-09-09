import { expect, test } from "@playwright/test";

test.setTimeout(90000);

const contract = "0xC35813d40961151c11C97cB9d67D0D25CD4Cc86e";
const seller = "0x1111111111111111111111111111111111111111";
const collections = [
  "0x2222222222222222222222222222222222222222",
  "0x3333333333333333333333333333333333333333",
];
const nativeOffer = {
  id: "native",
  source: "gnars-contract",
  protocolAddress: contract,
  orderHash: `0x${"11".repeat(32)}`,
  seller,
  priceWei: "10000000000000000",
  currency: "ETH",
  expiresAt: 2100000000,
};
const native = {
  tokenId: "42",
  name: "Gnar #42",
  image: "/gnars.webp",
  owner: seller,
  offers: [
    nativeOffer,
    { ...nativeOffer, id: "opensea", source: "opensea", priceWei: "20000000000000000" },
  ],
};
const community = collections.map((collectionAddress, index) => ({
  collectionAddress,
  collectionName: `Community ${index + 1}`,
  tokenId: "42",
  name: `Artwork ${index + 1}`,
  image: "/gnars.webp",
  owner: seller,
  offers: [{ ...nativeOffer, collectionAddress, id: `community-${index}` }],
}));
const base = {
  ownershipVerified: true,
  items: [native],
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

for (const width of [390, 1440]) {
  test(`ordered sale bands preserve collection identity at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 950 });
    await page.addInitScript(() => localStorage.setItem("theme", "dark"));
    const lookups: string[] = [];
    await page.route("**/api/marketplace**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/marketplace/community")
        return route.fulfill({ json: { items: community, nextCursor: null, available: true } });
      if (path.includes("/community/nfts/")) {
        lookups.push(path);
        return route.fulfill({
          json: {
            ...base,
            items: community.filter((item) => path.includes(item.collectionAddress)),
          },
        });
      }
      return route.fulfill({ json: base });
    });
    await page.goto("/pt-br/marketplace", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Atualizar anúncios", exact: true }).click();
    const bands = page.locator("section[aria-labelledby^='sale-band-']");
    await expect(bands).toHaveCount(3);
    await expect(bands.nth(0)).toHaveAttribute("aria-labelledby", "sale-band-native");
    await expect(bands.nth(1)).toHaveAttribute("aria-labelledby", "sale-band-community");
    await expect(bands.nth(2)).toHaveAttribute("aria-labelledby", "sale-band-opensea");
    await expect(bands.nth(0).getByText("0.01 ETH", { exact: true })).toBeVisible();
    await expect(bands.nth(1).getByRole("button", { name: /^Ver Artwork/ })).toHaveCount(2);
    await expect(bands.nth(2).getByText("0.02 ETH", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `test-results/community-sale-bands-${width}.png`,
      fullPage: true,
    });
    await bands.nth(1).getByRole("button", { name: "Ver Artwork 2", exact: true }).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByRole("heading", { name: "Artwork 2", exact: true })).toBeVisible();
    await expect(drawer.getByRole("link", { name: "Ver na OpenSea" })).toHaveAttribute(
      "href",
      `https://opensea.io/item/base/${collections[1]}/42`,
    );
    await expect
      .poll(() => lookups.some((path) => path.endsWith(`${collections[1]}/42`)))
      .toBe(true);
    expect(new URL(page.url()).searchParams.get("collection")).toBe(collections[1]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("dialog").getByRole("heading", { name: "Artwork 2", exact: true }),
    ).toBeVisible();
  });
}
