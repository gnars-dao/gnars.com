import { expect, test, type Locator, type Page } from "@playwright/test";
import { POIDH_SOPA } from "../../src/lib/config";
import type { SopaBounty } from "../../src/lib/poidh-sopa/types";

// Runs against live data: expectations about the team card are derived from the
// same Sopa API the page reads, so the spec holds whatever bounties are open.
const TIMEOUT = 90000;
const team = new Set(POIDH_SOPA.teamIssuers.map((a) => a.toLowerCase()));

async function openTeamBounties(page: Page): Promise<SopaBounty[]> {
  const res = await page.request.get("/api/poidh/sopa/bounties", { timeout: TIMEOUT });
  expect(res.ok()).toBe(true);
  const { bounties } = (await res.json()) as { bounties: SopaBounty[] };
  return bounties
    .filter((b) => b.status === "open" && team.has(b.issuer.toLowerCase()))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Page errors and hydration warnings collected while a test runs. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && /hydrat|did not match|server rendered/i.test(m.text())) {
      errors.push(`hydration: ${m.text()}`);
    }
  });
  return errors;
}

/** A card in the desktop fan (the phone row's cards carry `snap-center`). */
function fanCard(section: Locator, title: string) {
  return section.locator("div.relative.shrink-0:not(.snap-center)").filter({ hasText: title });
}

/**
 * Clicks until `done` holds: the server HTML is interactive-looking before React
 * hydrates, and a click that lands before hydration is silently dropped.
 */
async function clickUntil(target: Locator, done: () => Promise<void>) {
  await expect(async () => {
    await target.click();
    await done();
  }).toPass({ timeout: TIMEOUT });
}

async function gotoBounties(page: Page, path: string) {
  await page.goto(path, { waitUntil: "load", timeout: TIMEOUT });
  const section = page.locator("#bounties");
  await section.scrollIntoViewIfNeeded();
  await expect(section.locator("button[aria-pressed]").first()).toBeVisible({ timeout: TIMEOUT });
  return section;
}

test.describe("homepage bounties hand", () => {
  test.setTimeout(180000);

  test("desktop: the newest team bounty is the raised Legendary card and claims on this site", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    const teamOpen = await openTeamBounties(page);
    const section = await gotoBounties(page, "/");

    const legend = section.locator("button[aria-pressed]");
    const codes = await legend.allInnerTexts();
    expect(codes.length).toBeGreaterThan(0);
    expect(codes.length).toBeLessThanOrEqual(6);
    expect(new Set(codes).size, `duplicate codes: ${codes.join(", ")}`).toBe(codes.length);

    test.skip(teamOpen.length === 0, "no open team bounty right now");
    const headline = teamOpen[0];

    // The hand opens on the headline card.
    const active = section.locator('button[aria-pressed="true"]');
    await expect(active).toHaveAttribute("aria-label", new RegExp(`^GN-.*${headline.title}`));
    await expect(section.getByText("GNARS TEAM").first()).toBeVisible();
    await expect(section.getByText(/USDC|ETH/).first()).toBeVisible();

    // Flip it: the claim goes to the bounty's page here, not to poidh.xyz.
    const card = fanCard(section, headline.title);
    const flipper = card.locator("div.cursor-pointer").first();
    await clickUntil(flipper, () =>
      expect(flipper).toHaveCSS("transform", /^matrix3d\(-1,/, { timeout: 1500 }),
    );
    const claim = card.getByRole("link", { name: "Submit claim" });
    await expect(claim).toHaveAttribute("href", `/community/bounties/sopa/${headline.id}`);
    await expect(claim).not.toHaveAttribute("target", "_blank");

    await card.getByRole("link", { name: "View bounty →" }).click();
    await expect(page).toHaveURL(new RegExp(`/community/bounties/sopa/${headline.id}$`), {
      timeout: TIMEOUT,
    });
    await expect(page.getByText(headline.title).first()).toBeVisible({ timeout: TIMEOUT });

    expect(errors).toEqual([]);
  });

  test("desktop: picking a poidh card raises it, and its claim goes to poidh.xyz", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const section = await gotoBounties(page, "/");
    const poidhCode = section.locator("button[aria-pressed]").filter({ hasNotText: /^GN-/ });
    test.skip((await poidhCode.count()) === 0, "no poidh card in the hand right now");

    const pick = poidhCode.first();
    await clickUntil(pick, () =>
      expect(pick).toHaveAttribute("aria-pressed", "true", { timeout: 1500 }),
    );
    const label = (await pick.getAttribute("aria-label")) ?? "";
    const title = label.split(" — ").slice(1).join(" — ");

    const claim = fanCard(section, title).getByRole("link", { name: "Submit claim" });
    await expect(claim).toHaveAttribute(
      "href",
      /^https:\/\/poidh\.xyz\/(base|arbitrum)\/bounty\/\d+$/,
    );
    await expect(claim).toHaveAttribute("target", "_blank");
  });

  for (const width of [320, 375, 768]) {
    test(`phone ${width}px: no horizontal scroll, and the row opens on the headline card`, async ({
      page,
    }) => {
      const errors = watchErrors(page);
      await page.setViewportSize({ width, height: 800 });
      const teamOpen = await openTeamBounties(page);
      const section = await gotoBounties(page, "/");

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);

      if (teamOpen.length > 0) {
        const first = section.locator(".snap-center").first();
        await expect(first).toContainText(teamOpen[0].title);
        await expect(first).toContainText("GNARS TEAM");
        // The claim on the headline card goes to the bounty's page here.
        await expect(first.getByRole("link", { name: "Submit claim" })).toHaveAttribute(
          "href",
          `/community/bounties/sopa/${teamOpen[0].id}`,
        );
      }
      expect(errors).toEqual([]);
    });
  }

  test("PT-BR: team mark, Sopa type and reward copy are translated", async ({ page }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    const teamOpen = await openTeamBounties(page);
    const section = await gotoBounties(page, "/pt-br");

    await expect(section).toContainText("pague atletas em ETH ou USDC");
    await expect(section).not.toContainText("GNARS TEAM");
    if (teamOpen.length > 0) {
      await expect(section.getByText("EQUIPE GNARS").first()).toBeVisible();
      await expect(section).toContainText("Bounty Gnars");
    }
    // Tiles show values, not the unavailable placeholder, when both sources load.
    await expect(section).not.toContainText("Indisponível");
    expect(errors).toEqual([]);
  });

  for (const theme of ["light", "dark"] as const) {
    test(`${theme} theme: the section renders and is captured for review`, async ({
      page,
    }, testInfo) => {
      await page.addInitScript((t) => window.localStorage.setItem("theme", t), theme);
      await page.setViewportSize({ width: 1280, height: 900 });
      const section = await gotoBounties(page, "/");
      await expect(page.locator("html")).toHaveClass(
        new RegExp(theme === "dark" ? "dark" : "^(?!.*dark)"),
      );
      await page.waitForTimeout(1500);
      await section.screenshot({ path: testInfo.outputPath(`bounties-${theme}.png`) });
    });
  }
});
