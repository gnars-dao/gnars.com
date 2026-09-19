import { expect, test } from "@playwright/test";

for (const width of [390, 1440]) {
  test(`community search paginates and restores at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const requests: URLSearchParams[] = [];
    const item = (id: string, name: string) => ({
      tokenId: id,
      name,
      collectionName: "SkateHive",
      image: "/gnars.webp",
      collectionAddress: "0x4444444444444444444444444444444444444444",
      owner: "0x2222222222222222222222222222222222222222",
      offers: [
        {
          id,
          source: "gnars-contract",
          protocolAddress: "0xC35813d40961151c11C97cB9d67D0D25CD4Cc86e",
          orderHash: `0x${"01".repeat(32)}`,
          seller: "0x2222222222222222222222222222222222222222",
          priceWei: "10000000000000000",
          currency: "ETH",
          expiresAt: Math.floor(Date.now() / 1000) + 86400,
        },
      ],
    });
    await page.route("**/api/marketplace**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/marketplace/community") {
        requests.push(url.searchParams);
        const filtered = url.searchParams.get("q") === "SkateHive";
        return route.fulfill({
          json: {
            available: true,
            items: filtered
              ? [
                  url.searchParams.has("cursor")
                    ? item("2", "SkateHive #2")
                    : item("1", "SkateHive #1"),
                ]
              : [item("3", "Other NFT")],
            nextCursor: filtered && !url.searchParams.has("cursor") ? "10" : null,
          },
        });
      }
      return route.fulfill({
        json: {
          items: [],
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
    await page.goto("/pt-br/marketplace", { waitUntil: "domcontentloaded" });
    const community = page.locator("section[aria-labelledby='sale-band-community']");
    const search = community.getByRole("textbox", { name: "Nome do NFT, coleção, contrato ou ID" });
    await search.fill("SkateHive");
    await community.getByRole("button", { name: "Buscar NFTs da comunidade", exact: true }).click();
    await expect(community.getByText("SkateHive #1", { exact: true })).toBeVisible();
    await expect(community.getByText("Other NFT", { exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(/communitySearch=SkateHive/);
    await community.getByRole("button", { name: /Carregar mais/i }).click();
    await expect(community.getByText("SkateHive #2", { exact: true })).toBeVisible();
    expect(
      requests.some((params) => params.get("q") === "SkateHive" && params.get("cursor") === "10"),
    ).toBe(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(search).toHaveValue("SkateHive");
    await expect(community.getByText("SkateHive #1", { exact: true })).toBeVisible();
    await page.screenshot({
      path: `/tmp/marketplace-community-search-${width}.png`,
      fullPage: true,
    });
    await community.getByRole("button", { name: "Limpar busca da comunidade" }).click();
    await expect(search).toHaveValue("");
    await expect(page).not.toHaveURL(/communitySearch/);
    await expect(community.getByText("Other NFT", { exact: true })).toBeVisible();
    await expect(community.getByText("SkateHive #2", { exact: true })).toHaveCount(0);
  });
}
