import { expect, test } from "@playwright/test";

test.setTimeout(120_000);
test.use({
  launchOptions: {
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  },
});

for (const locale of ["en", "pt-br"]) {
  for (const width of [1440, 390]) {
    test(`${locale} homepage renders at ${width}px without translation failures`, async ({
      page,
    }, info) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setViewportSize({ width, height: 900 });
      const response = await page.goto(locale === "en" ? "/" : "/pt-br", {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      });
      expect(response?.status()).toBe(200);
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expect(page.locator("main")).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.screenshot({ path: info.outputPath(`${locale}-${width}.png`) });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      expect(
        errors.filter((error) => /MISSING_MESSAGE|Couldn't infer|useTranslations/.test(error)),
      ).toEqual([]);
    });
  }
}

test("migration never mounts or fetches the floating TV", async ({ page }) => {
  let feedRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/tv/feed")) feedRequests++;
  });
  const response = await page.goto("/pt-br/migrate", {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  expect(response?.status()).toBe(200);
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator('[role="button"].fixed.bottom-4.left-4')).toHaveCount(0);
  expect(feedRequests).toBe(0);
});

test("public APIs reject unauthorized or unbounded work", async ({ request }) => {
  expect((await request.post("/api/revalidate", { data: { tags: ["stake"] } })).status()).toBe(400);
  expect(
    (
      await request.post("/api/alchemy", {
        data: { method: "eth_sendRawTransaction", params: ["0x"] },
      })
    ).status(),
  ).toBe(400);
  expect(
    (
      await request.post("/api/pinata/signed-url", {
        data: {
          upload: { filename: "test.png", mimeType: "image/png", size: 1024 },
        },
      })
    ).status(),
  ).toBe(401);
  expect((await request.get("/api/proposals?limit=999999999")).status()).toBe(400);
  const readiness = await request.get("/api/store/checkout");
  expect(readiness.ok()).toBe(true);
  expect(typeof (await readiness.json()).ready).toBe("boolean");
});

test.describe("3D television", () => {
  test("renders moving frames and fits portrait fullscreen", async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/pt-br/blogs", { waitUntil: "domcontentloaded" });
    const mini = page.locator('[role="button"].fixed.bottom-4.left-4');
    const canvas = mini.locator("canvas");
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    const first = await canvas.screenshot();
    await expect.poll(async () => first.equals(await canvas.screenshot())).toBe(false);
    await page.screenshot({ path: info.outputPath("tv-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await mini.click();
    const fullscreen = page.locator(".fixed.inset-0 canvas");
    await expect(fullscreen).toBeVisible();
    // Allow the video texture's Suspense boundary and fullscreen transition to settle.
    await page.waitForTimeout(5_000);
    await page.screenshot({ path: info.outputPath("tv-pt-br-mobile.png") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.keyboard.press("Escape");
    await expect(mini).toBeVisible();
  });
});
