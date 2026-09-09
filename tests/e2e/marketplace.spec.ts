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
  ownershipVerified: true,
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
    await expect(page.getByRole("tab").first()).toHaveText("À venda");
    await expect(page.getByRole("tab", { name: "À venda", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.getByRole("button", { name: "Atualizar anúncios", exact: true }).click();
    await expect(page.getByRole("button", { name: "Ver Gnar #42", exact: true })).toBeVisible();
    await expect(page.getByText("0.0123 ETH", { exact: true })).toBeVisible();
    const card = page.getByRole("button", { name: "Ver Gnar #42", exact: true });
    await expect(card.getByText("OpenSea", { exact: true })).toBeVisible();
    await expect(card.locator("time")).toHaveAttribute(
      "datetime",
      new Date(offer.expiresAt * 1000).toISOString(),
    );
    await expect(card.getByRole("img")).toBeVisible();
    await page.screenshot({
      path: `test-results/marketplace-cards-${mobile ? "mobile" : "desktop"}.png`,
      fullPage: true,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole("button", { name: "Ver Gnar #42", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toHaveAttribute("data-vaul-drawer-direction", mobile ? "bottom" : "right");
    await expect
      .poll(async () => {
        const box = await dialog.boundingBox();
        return !!box && Math.abs(mobile ? box.y + box.height - 844 : box.x + box.width - 1280) < 2;
      })
      .toBe(true);
    const drawerBox = await dialog.boundingBox();
    expect(drawerBox?.width).toBeCloseTo(mobile ? 390 : 560, 2);
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
    expect(
      await dialog
        .locator("[data-vaul-no-drag]")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Ver Gnar #42", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Ver Gnar #42", exact: true }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Fechar", exact: true }).click();
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
  await page.getByRole("button", { name: "Refresh listings", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Couldn't load" })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByText("No active listings found.")).not.toBeVisible();
});

test("mobile cards keep exact prices and multiple sources inside their bounds", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.route("**/api/marketplace**", (route) =>
    route.fulfill({
      json: {
        ...data,
        items: [
          {
            ...item,
            name: "Gnar #42 with an unusually long collection item name",
            offers: [
              offer,
              {
                ...offer,
                id: "native-order",
                source: "gnars",
                orderHash: offer.orderHash,
                priceWei: "1",
              },
            ],
          },
        ],
      },
    }),
  );
  await page.goto("/pt-br/marketplace", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Atualizar anúncios", exact: true }).click();
  const card = page.getByRole("button", { name: "Ver Gnar #42", exact: true });
  await expect(card.getByText("1e-18 ETH", { exact: true })).toBeVisible();
  await expect(card.getByTitle("0.000000000000000001 ETH")).toHaveAttribute(
    "aria-label",
    "0.000000000000000001 ETH",
  );
  await expect(card.getByText("OpenSea", { exact: true })).toBeVisible();
  await expect(card.getByText("Seaport", { exact: true })).toBeVisible();
  await expect(card.getByTitle("2 anúncios")).toBeVisible();
  expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("collection stays directly linkable after changing the default tab", async ({ page }) => {
  await page.route("**/api/marketplace**", (route) => route.fulfill({ json: data }));
  await page.goto("/pt-br/marketplace?view=catalogue", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("tab", { name: "Coleção", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(new URL(page.url()).searchParams.get("view")).toBe("catalogue");
  await expect(page.getByRole("button", { name: "Ver Gnar #42", exact: true })).toBeVisible();
});

test("reflective cards use NFT artwork without camera access and respect reduced motion", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: () => {
        document.documentElement.dataset.cameraRequested = "true";
        return Promise.reject(new Error("Camera access forbidden in this test"));
      },
    });
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.route("**/api/marketplace**", (route) => route.fulfill({ json: data }));
  await page.goto("/pt-br/marketplace", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Atualizar anúncios", exact: true }).click();
  const card = page.getByRole("button", { name: "Ver Gnar #42", exact: true });
  await expect(card).toBeVisible();
  const box = (await card.boundingBox())!;
  await card.dispatchEvent("pointermove", {
    pointerType: "mouse",
    clientX: box.x + 10,
    clientY: box.y + 10,
  });
  await expect
    .poll(() => card.evaluate((el) => el.style.getPropertyValue("--card-rotate-x")))
    .not.toBe("0deg");
  await card.dispatchEvent("pointerleave", { pointerType: "mouse" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await card.dispatchEvent("pointermove", {
    pointerType: "mouse",
    clientX: box.x + 10,
    clientY: box.y + 10,
  });
  expect(await card.evaluate((el) => getComputedStyle(el).transform)).toBe("none");
  expect(await card.evaluate((el) => el.style.getPropertyValue("--card-rotate-x"))).toBe("");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await card.dispatchEvent("pointermove", {
    pointerType: "touch",
    clientX: box.x + 10,
    clientY: box.y + 10,
  });
  expect(await card.evaluate((el) => el.style.getPropertyValue("--card-rotate-x"))).toBe("");
  await expect(card.locator("video")).toHaveCount(0);
  expect(
    await page.evaluate(() => document.documentElement.dataset.cameraRequested),
  ).toBeUndefined();
});

test("drawer switches edges on resize and preserves the selected NFT", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route("**/api/marketplace**", (route) =>
    route.fulfill({ json: { ...data, capabilities: { ...data.capabilities, openseaBuy: true } } }),
  );
  await page.goto("/pt-br/marketplace", { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "À venda", exact: true }).click();
  await page.getByRole("button", { name: "Atualizar anúncios", exact: true }).click();
  await page.getByRole("button", { name: "Ver Gnar #42", exact: true }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toHaveAttribute("data-vaul-drawer-direction", "right");
  await drawer.getByRole("button", { name: "Comprar", exact: true }).click();
  await expect(drawer.getByText("Preço total", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 640 });
  await expect(drawer).toHaveAttribute("data-vaul-drawer-direction", "bottom");
  await expect(drawer.getByRole("heading", { name: "Gnar #42", exact: true })).toBeVisible();
  await expect(drawer.getByText("Preço total", { exact: true })).toBeVisible();
  const scrollArea = drawer.locator("[data-vaul-no-drag]");
  await scrollArea.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(drawer.getByRole("button", { name: "Fechar", exact: true })).toBeVisible();
  expect(await drawer.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(drawer).toHaveAttribute("data-vaul-drawer-direction", "right");
  await page.locator('[data-slot="drawer-overlay"]').click({ position: { x: 40, y: 100 } });
  await expect(drawer).not.toBeVisible();
});

test("mobile drawer can be dismissed by dragging its header", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/marketplace**", (route) => route.fulfill({ json: data }));
  await page.goto("/pt-br/marketplace", { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "À venda", exact: true }).click();
  await page.getByRole("button", { name: "Atualizar anúncios", exact: true }).click();
  await page.getByRole("button", { name: "Ver Gnar #42", exact: true }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toHaveAttribute("data-vaul-drawer-direction", "bottom");
  await expect.poll(async () => Math.round((await drawer.boundingBox())!.y)).toBe(68);
  await page.mouse.move(195, 95);
  await page.mouse.down();
  await page.mouse.move(195, 420, { steps: 15 });
  await page.mouse.up();
  await expect(drawer).not.toBeVisible();
});

test("shared NFT links restore the drawer and closing removes only its selection", async ({
  page,
}) => {
  await page.route("**/api/marketplace**", (route) => route.fulfill({ json: data }));
  await page.goto("/pt-br/marketplace?view=listings&nft=42", { waitUntil: "domcontentloaded" });
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByRole("heading", { name: "Gnar #42", exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "Fechar", exact: true }).click();
  await expect(drawer).not.toBeVisible();
  await expect(page.getByRole("tab", { name: "À venda", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect.poll(() => new URL(page.url()).searchParams.get("nft")).toBeNull();
  expect(new URL(page.url()).searchParams.get("view")).toBeNull();
});

test("exact ID search persists in the URL and unconfigured native source is not an outage", async ({
  page,
}) => {
  await page.route("**/api/marketplace**", (route) =>
    route.fulfill({ json: { ...data, items: [{ ...item, offers: [] }] } }),
  );
  await page.goto("/pt-br/marketplace", { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "Buscar por ID do Gnar" }).fill("#42");
  await page.getByRole("button", { name: "Buscar Gnar", exact: true }).click();
  await expect(page.getByRole("button", { name: "Ver Gnar #42", exact: true })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("42");
  await expect(page.getByText("Não anunciado", { exact: true })).toBeVisible();
  await expect(page.getByText(/Os anúncios da Gnars estão indisponíveis/)).toHaveCount(0);
  await page.getByRole("tab", { name: "Meus anúncios", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Conecte sua carteira", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get("q")).toBeNull();
});
