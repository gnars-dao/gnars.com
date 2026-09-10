import { expect, test, type Page } from "@playwright/test";
import { zeroAddress } from "viem";
import { COMMUNITY_FEE_RECIPIENT } from "../../src/lib/marketplace/community-policy";
import { buildCommunityListingQuote } from "../../src/lib/marketplace/listing-intent";

const owner = "0x1111111111111111111111111111111111111111";
const collection = "0x2222222222222222222222222222222222222222";
const note = (
  '<img src=x onerror="window.__noteExecuted=1">\n' + "NotaDoVendedor".repeat(17)
).slice(0, 280);
const item = {
  collectionAddress: collection,
  collectionName: "Coleção da comunidade",
  tokenId: "42",
  name: "Community NFT #42",
  image: "/gnars.webp",
  owner,
  offers: [
    {
      id: "note-order",
      source: "gnars-contract",
      orderHash: `0x${"11".repeat(32)}`,
      protocolAddress: "0xC35813d40961151c11C97cB9d67D0D25CD4Cc86e",
      seller: owner,
      priceWei: "20000000000000000",
      currency: "ETH",
      expiresAt: 2100000000,
      listingComment: note,
    },
  ],
};
const pageData = {
  ownershipVerified: true,
  items: [item],
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

async function fixture(page: Page, wallet = false) {
  const writes: string[] = [];
  async function rpc({ method }: { method: string }) {
    if (/send|sign|personal_/i.test(method)) {
      writes.push(method);
      throw Object.assign(new Error("Wallet writes forbidden"), { code: 4001 });
    }
    if (["eth_accounts", "eth_requestAccounts"].includes(method)) return [owner];
    if (method === "eth_chainId") return "0x2105";
    if (method === "net_version") return "8453";
    if (method === "wallet_getPermissions") return [{ parentCapability: "eth_accounts" }];
    if (method === "wallet_getCapabilities") return {};
    if (method === "eth_getCode") return "0x";
    if (method === "eth_getBalance") return "0xde0b6b3a7640000";
    if (method === "eth_blockNumber") return "0x2710";
    if (method === "eth_getTransactionCount") return "0x0";
    if (method === "eth_call") return `0x${"0".repeat(64)}`;
    return null;
  }
  await page.addInitScript(() => localStorage.setItem("theme", "dark"));
  if (wallet) {
    await page.exposeFunction("notesTestRpc", rpc);
    await page.addInitScript(() => {
      localStorage.setItem("gnars:view-as", "eoa");
      const callbacks: Record<string, Array<(...args: unknown[]) => void>> = {};
      const provider = {
        isMetaMask: true,
        request: (input: unknown) =>
          (window as unknown as { notesTestRpc(input: unknown): Promise<unknown> }).notesTestRpc(
            input,
          ),
        on(event: string, callback: (...args: unknown[]) => void) {
          (callbacks[event] ??= []).push(callback);
          return provider;
        },
        removeListener(event: string, callback: (...args: unknown[]) => void) {
          callbacks[event] = (callbacks[event] ?? []).filter((value) => value !== callback);
          return provider;
        },
      };
      Object.defineProperty(window, "ethereum", { value: provider, configurable: true });
      const info = {
        uuid: "00000000-0000-4000-8000-000000000001",
        name: "MetaMask",
        icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
        rdns: "io.metamask",
      };
      const announce = () =>
        window.dispatchEvent(
          new CustomEvent("eip6963:announceProvider", {
            detail: Object.freeze({ info, provider }),
          }),
        );
      window.addEventListener("eip6963:requestProvider", announce);
      announce();
    });
  }
  await page.route("**/*", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST") {
      let payload;
      try {
        payload = request.postDataJSON();
      } catch {
        payload = null;
      }
      const inputs = Array.isArray(payload) ? payload : [payload];
      if (
        inputs.every(
          (input) => input && typeof input === "object" && "method" in input && "jsonrpc" in input,
        )
      ) {
        const responses = await Promise.all(
          inputs.map(async (input) => ({ jsonrpc: "2.0", id: input.id, result: await rpc(input) })),
        );
        return route.fulfill({ json: Array.isArray(payload) ? responses : responses[0] });
      }
    }
    if (path === "/api/marketplace/community/eligibility")
      return route.fulfill({
        json: {
          owner,
          balance: "6",
          minimum: 6,
          eligible: true,
          feeBps: 100,
          feeRecipient: COMMUNITY_FEE_RECIPIENT,
          canModerate: false,
        },
      });
    if (path.startsWith("/api/marketplace/community/nfts/"))
      return route.fulfill({
        json: { ...pageData, items: [wallet ? { ...item, offers: [] } : item] },
      });
    if (path === "/api/marketplace/community/wallet")
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === "/api/marketplace/community/quote")
      return route.fulfill({
        json: {
          quote: buildCommunityListingQuote(
            request.postDataJSON().priceWei,
            { amount: 0n, recipient: zeroAddress },
            { basisPoints: 100, recipient: COMMUNITY_FEE_RECIPIENT },
          ),
        },
      });
    if (path === "/api/marketplace/community")
      return route.fulfill({ json: { items: [item], nextCursor: null, available: true } });
    if (path.startsWith("/api/marketplace"))
      return route.fulfill({ json: { ...pageData, items: [] } });
    if (path.includes("/api/ens")) return route.fulfill({ json: { ens: null, address: null } });
    if (request.method() === "POST" && new URL(request.url()).origin !== new URL(page.url()).origin)
      return route.abort("blockedbyclient");
    return route.continue();
  });
  return writes;
}

test.setTimeout(90000);
test.beforeEach(({ page }) => page.setDefaultTimeout(15000));

for (const mobile of [false, true]) {
  test.describe(mobile ? "touch cards" : "desktop cards", () => {
    test.use({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      isMobile: mobile,
      hasTouch: mobile,
    });
    test("seller note keeps card dimensions, escapes HTML and opens details", async ({ page }) => {
      const writes = await fixture(page);
      await page.goto("/pt-br/marketplace", { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
      await page.getByRole("button", { name: "Atualizar anúncios", exact: true }).click();
      const card = page
        .locator("[data-marketplace-card]")
        .filter({ has: page.getByRole("heading", { name: item.name, exact: true }) });
      await expect(card).toHaveCount(1);
      await card.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await expect(card).toHaveAttribute("data-flipped", "false");
      const before = await card.boundingBox();
      if (mobile)
        await card.getByRole("button", { name: "Ver nota do vendedor", exact: true }).tap();
      else await card.hover();
      await expect(card).toHaveAttribute("data-flipped", "true");
      const back = card
        .locator('[aria-hidden="false"]')
        .filter({ has: page.getByText(note, { exact: true }) });
      await expect(back.getByText(note, { exact: true })).toBeVisible();
      await expect(back.getByText("0.02 ETH", { exact: true })).toBeVisible();
      for (const target of [
        back.getByText("0.02 ETH", { exact: true }),
        back.getByRole("button", { name: `Ver ${item.name}`, exact: true }),
      ]) {
        await expect
          .poll(() =>
            target.evaluate((element) => {
              const rect = element.getBoundingClientRect();
              const top = document.elementFromPoint(
                rect.x + rect.width / 2,
                rect.y + rect.height / 2,
              );
              return !!top && (top === element || element.contains(top));
            }),
          )
          .toBe(true);
      }
      expect(await card.locator("img[onerror]").count()).toBe(0);
      expect(
        await page.evaluate(
          () => (window as unknown as { __noteExecuted?: number }).__noteExecuted,
        ),
      ).toBeUndefined();
      await expect
        .poll(async () => Math.abs((await card.boundingBox())!.height - before!.height))
        .toBeLessThan(1);
      expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      expect(await back.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/marketplace-note-${mobile ? "mobile" : "desktop"}.png`,
        fullPage: false,
        animations: "disabled",
      });
      if (mobile) {
        await card.getByRole("button", { name: "Ver arte do NFT", exact: true }).tap();
        await expect(card).toHaveAttribute("data-flipped", "false");
        await card.getByRole("button", { name: "Ver nota do vendedor", exact: true }).tap();
      } else {
        await back.getByRole("button", { name: `Ver ${item.name}`, exact: true }).focus();
        await page.keyboard.press("Escape");
        await expect(card).toHaveAttribute("data-flipped", "false");
        await expect(
          card.getByRole("button", { name: "Ver nota do vendedor", exact: true }),
        ).toBeFocused();
        await page.mouse.move(0, 0);
        await card.hover();
      }
      await back.getByRole("button", { name: `Ver ${item.name}`, exact: true }).click();
      await expect(
        page.getByRole("dialog").getByRole("heading", { name: item.name, exact: true }),
      ).toBeVisible();
      expect(writes).toEqual([]);
    });
  });
}

test("reduced motion disables the flip transition", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fixture(page);
  await page.goto("/pt-br/marketplace", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.getByRole("button", { name: "Atualizar anúncios", exact: true }).click();
  const card = page
    .locator("[data-marketplace-card]")
    .filter({ has: page.getByRole("heading", { name: item.name, exact: true }) });
  await card.hover();
  await expect(card).toHaveAttribute("data-flipped", "true");
  const seconds = await card
    .locator(":scope > div")
    .first()
    .evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration));
  // The global reduced-motion reset preserves transition events with a 0.01ms duration.
  expect(seconds).toBeLessThanOrEqual(0.00001);
});

test("community listing note is optional, bounded and retained across wizard steps", async ({
  page,
}) => {
  const writes = await fixture(page, true);
  await page.goto("/pt-br/marketplace", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.getByRole("tab", { name: "Meus Gnars", exact: true }).click();
  await page
    .getByRole("button", { name: /conectar|connect/i })
    .last()
    .click();
  await page.getByRole("button", { name: /connect a wallet/i }).click();
  await page.getByRole("button", { name: /metamask/i }).click();
  await expect(page.getByRole("dialog", { name: "Connect Wallet", exact: true })).not.toBeVisible({
    timeout: 30000,
  });
  await page.getByRole("button", { name: "Anunciar seu NFT", exact: true }).click();
  const drawer = page.getByRole("dialog");
  await drawer.getByText("Inserir contrato e ID do token", { exact: true }).click();
  await drawer.getByLabel("Endereço do contrato NFT").fill(collection);
  await drawer.getByLabel("ID do token", { exact: true }).fill("42");
  await drawer.getByRole("button", { name: "Buscar NFT", exact: true }).click();
  await drawer.getByRole("button", { name: "Continuar", exact: true }).click();
  const comment = drawer.getByLabel("Comentário (opcional)", { exact: true });
  await expect(comment).toHaveValue("");
  await expect(comment).toHaveAttribute("maxlength", "280");
  await drawer.getByLabel("Preço (ETH)", { exact: true }).fill("0.02");
  await expect(
    drawer.getByRole("button", { name: "Revisar e assinar anúncio", exact: true }),
  ).toBeEnabled();
  await comment.fill(note);
  await expect(comment).toHaveValue(note);
  await comment.press("End");
  await comment.press("x");
  await expect(comment).toHaveValue(note);
  await drawer.getByRole("button", { name: "Voltar", exact: true }).click();
  await drawer.getByRole("button", { name: "Continuar", exact: true }).click();
  await expect(comment).toHaveValue(note);
  expect(writes).toEqual([]);
  await expect
    .poll(async () => {
      const box = await drawer.boundingBox();
      return box ? Math.abs(box.x + box.width - (await page.evaluate(() => innerWidth))) : 1000;
    })
    .toBeLessThan(2);
  await page.screenshot({
    path: "test-results/marketplace-note-form-ptbr.png",
    animations: "disabled",
  });
});
