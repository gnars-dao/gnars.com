import { expect, test } from "@playwright/test";

test.setTimeout(120_000);

for (const width of [1280, 390]) {
  test(`Morpheus backing and pending routing at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const graph = {
      athletes: [
        {
          id: "will",
          handle: "will",
          vault: "0x0000000000000000000000000000000000000000",
          vaultTvl: 0,
          morUsd: 226,
          total: 226,
          feeAccrued: 0,
          backers: [
            {
              address: "0xAf32BB3892F37c518f3841275F131384a41B9b57",
              ens: "coletivoxv.eth",
              kind: "mor",
              asset: "steth",
              amount: 175,
              tokenAmount: "0.07",
              routing: "verified-split",
            },
            {
              address: "0x0000000000000000000000000000000000000001",
              ens: "pending.eth",
              kind: "mor",
              asset: "usdc",
              amount: 51,
              tokenAmount: "51",
              routing: "unconfigured",
            },
          ],
        },
      ],
      total: 226,
      backerCount: 2,
      backersResolved: true,
      morResolved: true,
      gnarsAccrued: 0,
      gnarsMor: 0,
      gnarsMorUsd: 0,
      treasuryUsd: 0,
    };
    await page.route("**/api/stake-graph", (route) => route.fulfill({ json: graph }));
    await page.goto("/pt-br/stake/will", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("$226 apoiando Will")).toBeVisible({ timeout: 45_000 });
    const social = page.getByRole("heading", { name: "Quem já está apoiando" });
    await social.scrollIntoViewIfNeeded();
    const labels = page.locator(width < 768 ? "p" : "svg text");
    await expect(labels.filter({ hasText: /^0,07 stETH$/ })).toBeVisible();
    await expect(labels.filter({ hasText: /^51 USDC$/ })).toBeVisible();
    await expect(labels.filter({ hasText: /^Recompensas por configurar$/ })).toBeVisible();
    if (width > 768) {
      await expect(page.locator('[data-routing="verified-split"]')).toHaveCount(1);
      await expect(page.locator('[data-routing="unconfigured"]')).toHaveCount(1);
    }
    await page.waitForTimeout(1000);
    await page.screenshot({ path: info.outputPath(`orbit-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );

    graph.morResolved = false;
    await page.reload({ waitUntil: "domcontentloaded" });
    await social.scrollIntoViewIfNeeded();
    await expect(page.getByText(/Os dados da Morpheus estão incompletos/).first()).toBeVisible({
      timeout: 45_000,
    });
    expect(
      errors.filter((error) => /MISSING_MESSAGE|useTranslations|Hydration failed/.test(error)),
    ).toEqual([]);
  });
}
