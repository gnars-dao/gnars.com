import { expect, test } from "@playwright/test";

test("NFT creation remains disabled without a configured verified contract", async ({ page }) => {
  await page.route("**/api/create-nft/status", (route) =>
    route.fulfill({ json: { ready: false } }),
  );
  await page.goto("/pt-br/create-nft");
  await expect(page.getByRole("heading", { name: "Criar NFT", exact: true })).toBeVisible();
  await expect(
    page.getByText("O contrato de criação de NFTs ainda não foi configurado."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Criar na Base" })).toHaveCount(0);
});

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`NFT creation media form ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.route("**/api/create-nft/status", (route) =>
      route.fulfill({
        json: {
          ready: true,
          address: `0x${"12".repeat(20)}`,
          royaltyBps: 150,
          recipient: `0x${"34".repeat(20)}`,
        },
      }),
    );
    await page.goto("/pt-br/create-nft");
    await expect(page.getByLabel("Nome", { exact: true })).toBeVisible();
    await page.getByLabel("Nome", { exact: true }).fill("Gnars artwork");
    await page.locator("#nft-artwork").setInputFiles({
      name: "art.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    await expect(page.getByRole("img", { name: "Gnars artwork" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Criar na Base" })).toBeDisabled();
    await expect(page.getByText("1.5%", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    ).toBeTruthy();
    await page.screenshot({
      path: `test-results/create-nft-${viewport.width}.png`,
      fullPage: true,
    });
  });
}

test("local NFT deploy requires an explicit royalty and connected wallet", async ({ page }) => {
  await page.goto("/pt-br/local-nft-deploy");
  await expect(page.getByRole("heading", { name: "Publicar Gnars Community NFT" })).toBeVisible();
  await expect(page.getByLabel("Royalty (pontos-base; 100 = 1%)", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Preparar deploy" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Publicar com a carteira" })).toHaveCount(0);
});
