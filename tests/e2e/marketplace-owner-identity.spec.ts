import { expect, test } from "@playwright/test";

const eoa = "0x1111111111111111111111111111111111111111";
const smartWallet = "0x2222222222222222222222222222222222222222";

for (const scenario of [
  { owner: eoa, name: "rider.eth", status: 200, label: "EOA" },
  {
    owner: smartWallet,
    name: `${"community".repeat(12)}.eth`,
    status: 200,
    label: "smart wallet with a long name",
  },
  { owner: smartWallet, name: null, status: 200, label: "unnamed smart wallet" },
  { owner: eoa, name: null, status: 503, label: "identity provider failure" },
]) {
  test(`marketplace owner identity: ${scenario.label}`, async ({ page }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width: 390, height: 844 });
    const lookups: string[] = [];
    await page.route("**/api/ens?address=*", async (route) => {
      const address = new URL(route.request().url()).searchParams.get("address")!;
      lookups.push(address);
      await route.fulfill({
        status: scenario.status,
        json: {
          ens: { address, name: scenario.name, avatar: scenario.name ? "/gnars.webp" : null },
        },
      });
    });
    await page.route("**/api/marketplace**", (route) =>
      route.fulfill({
        json: {
          ownershipVerified: true,
          items: [
            {
              tokenId: "42",
              name: "Gnar #42",
              image: "/gnars.webp",
              owner: scenario.owner,
              offers: [],
            },
          ],
          nextCursor: null,
          sources: {
            catalogue: { available: true },
            opensea: { available: true },
            gnars: { available: true },
          },
          capabilities: { openseaBuy: false, localTrading: false },
        },
      }),
    );
    await page.goto("/pt-br/marketplace?nft=42", { waitUntil: "domcontentloaded" });
    const drawer = page.getByRole("dialog", { name: "Gnar #42", exact: true });
    const owner = drawer.locator(`a[href="/pt-br/members/${scenario.owner}"]`);
    await expect(owner).toBeVisible();
    await expect(owner).toHaveAttribute("title", scenario.owner);
    await expect(owner).toContainText(
      scenario.name ?? `${scenario.owner.slice(0, 6)}...${scenario.owner.slice(-6)}`,
    );
    await expect.poll(() => lookups.filter((address) => address === scenario.owner).length).toBe(1);
    if (scenario.name) {
      await expect(owner.locator("img")).toHaveAttribute("src", "/gnars.webp");
      await expect
        .poll(() => owner.locator("img").evaluate((img) => (img as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(0);
    }
    expect(
      await drawer
        .locator("[data-vaul-no-drag]")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await owner.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `test-results/marketplace-identity-${scenario.label.replaceAll(" ", "-")}.png`,
    });
    // Identity is public owner metadata: no connected wallet or signing is necessary.
    await owner.focus();
    await expect(owner).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(drawer).not.toBeVisible();
    if (scenario.status === 200) {
      await page.getByRole("tab", { name: "Coleção", exact: true }).click();
      await page.getByRole("button", { name: "Ver Gnar #42", exact: true }).click();
      await expect(owner).toContainText(scenario.name ?? "0x2222...222222");
      expect(lookups.filter((address) => address === scenario.owner)).toHaveLength(1);
    }
  });
}
