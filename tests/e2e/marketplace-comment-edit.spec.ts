import { expect, test, type Page } from "@playwright/test";

const owner = "0x1111111111111111111111111111111111111111";
const collection = "0x2222222222222222222222222222222222222222";
const orderHash = `0x${"11".repeat(32)}`;
const commentPath = `/api/marketplace/community/orders/${orderHash}/comment`;

async function setup(
  page: Page,
  options: { reject?: boolean; conflict?: boolean; hold?: boolean } = {},
) {
  const signatures: string[] = [];
  const patches: Array<{ listingComment: string | null; expectedRevision: number }> = [];
  const transactions: string[] = [];
  let offer = {
    id: "comment-edit-order",
    source: "gnars-contract",
    orderHash,
    protocolAddress: "0xC35813d40961151c11C97cB9d67D0D25CD4Cc86e",
    collectionAddress: collection,
    seller: owner,
    priceWei: "20000000000000000",
    currency: "ETH",
    expiresAt: 2100000000,
    listingComment: "Original comment" as string | undefined,
    listingCommentRevision: 0,
  };
  let releaseSignature = () => {};
  const signatureReady = new Promise<void>((resolve) => {
    releaseSignature = resolve;
  });
  const data = () => ({
    ownershipVerified: true,
    items: [
      {
        collectionAddress: collection,
        collectionName: "Community",
        tokenId: "42",
        name: "Community NFT #42",
        image: "/gnars.webp",
        owner,
        offers: [offer],
      },
    ],
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
  });
  async function rpc({ method, params }: { method: string; params?: unknown[] }) {
    if (/send/i.test(method)) {
      transactions.push(method);
      throw new Error("Real transactions forbidden");
    }
    if (/sign|personal_/i.test(method)) {
      signatures.push(JSON.stringify(params));
      if (options.hold) await signatureReady;
      if (options.reject) throw Object.assign(new Error("User rejected request"), { code: 4001 });
      return `0x${"11".repeat(64)}1b`;
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
  await page.exposeFunction("commentTestRpc", rpc);
  await page.addInitScript(() => {
    localStorage.setItem("theme", "dark");
    localStorage.setItem("gnars:view-as", "eoa");
    const callbacks: Record<string, Array<(...args: unknown[]) => void>> = {};
    const provider = {
      isMetaMask: true,
      request: (input: unknown) =>
        (window as unknown as { commentTestRpc(input: unknown): Promise<unknown> }).commentTestRpc(
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
    Object.assign(window, {
      changeCommentWallet: () =>
        callbacks.accountsChanged?.forEach((callback) =>
          callback(["0x3333333333333333333333333333333333333333"]),
        ),
    });
    const info = {
      uuid: "00000000-0000-4000-8000-000000000001",
      name: "MetaMask",
      icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
      rdns: "io.metamask",
    };
    const announce = () =>
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }),
      );
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST") {
      let body;
      try {
        body = request.postDataJSON();
      } catch {
        body = null;
      }
      const inputs = Array.isArray(body) ? body : [body];
      if (
        inputs.every(
          (input) => input && typeof input === "object" && "jsonrpc" in input && "method" in input,
        )
      ) {
        const responses = await Promise.all(
          inputs.map(async (input) => ({ jsonrpc: "2.0", id: input.id, result: await rpc(input) })),
        );
        return route.fulfill({ json: Array.isArray(body) ? responses : responses[0] });
      }
    }
    if (path === commentPath) {
      if (request.method() === "GET") return route.fulfill({ json: { offer } });
      const body = request.postDataJSON();
      patches.push(body);
      if (options.conflict && patches.length === 1) {
        offer = { ...offer, listingComment: "Updated in another tab", listingCommentRevision: 1 };
        return route.fulfill({ status: 409, json: { error: "Revision conflict" } });
      }
      expect(body.expectedRevision).toBe(offer.listingCommentRevision);
      offer = {
        ...offer,
        listingComment: body.listingComment ?? undefined,
        listingCommentRevision: offer.listingCommentRevision + 1,
      };
      return route.fulfill({ json: { offer } });
    }
    if (path === "/api/marketplace/community/eligibility")
      return route.fulfill({
        json: { owner, balance: "6", minimum: 6, eligible: true, canModerate: false },
      });
    if (path.startsWith("/api/marketplace/community/nfts/")) return route.fulfill({ json: data() });
    if (path === "/api/marketplace/community")
      return route.fulfill({ json: { ...data(), available: true } });
    if (path.startsWith("/api/marketplace"))
      return route.fulfill({ json: { ...data(), items: [] } });
    if (path.includes("/api/ens")) return route.fulfill({ json: { ens: null, address: null } });
    if (request.method() === "POST" && new URL(request.url()).origin !== new URL(page.url()).origin)
      return route.abort("blockedbyclient");
    return route.continue();
  });
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
  await page.getByRole("tab", { name: "À venda", exact: true }).click();
  await page.getByRole("button", { name: "Atualizar anúncios", exact: true }).click();
  const card = page
    .locator("[data-marketplace-card]")
    .filter({ has: page.getByRole("heading", { name: "Community NFT #42", exact: true }) });
  await card.hover();
  await card.getByRole("button", { name: "Ver Community NFT #42", exact: true }).click();
  const drawer = page.getByRole("dialog");
  await drawer.getByRole("button", { name: "Editar comentário", exact: true }).click();
  return { drawer, signatures, patches, transactions, releaseSignature };
}

test.setTimeout(90000);
test.use({ viewport: { width: 1440, height: 1000 } });

test("seller edits and clears a comment with message signatures, no transaction", async ({
  page,
}) => {
  const state = await setup(page);
  const text = state.drawer.getByLabel("Comentário do vendedor", { exact: true });
  await text.fill("New seller note");
  await text.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: "/tmp/gnars-comment-editor-desktop.png", animations: "disabled" });
  await state.drawer.getByRole("button", { name: "Assinar e salvar", exact: true }).click();
  await expect(state.drawer.getByText("Comentário atualizado.", { exact: true })).toBeVisible();
  await expect(state.drawer.getByText("New seller note", { exact: true })).toBeVisible();
  await state.drawer.getByRole("button", { name: "Editar comentário", exact: true }).click();
  await text.fill("");
  await state.drawer.getByRole("button", { name: "Assinar e salvar", exact: true }).click();
  await expect(state.drawer.getByText("Comentário atualizado.", { exact: true })).toBeVisible();
  expect(
    state.patches.map(({ listingComment, expectedRevision }) => ({
      listingComment,
      expectedRevision,
    })),
  ).toEqual([
    { listingComment: "New seller note", expectedRevision: 0 },
    { listingComment: null, expectedRevision: 1 },
  ]);
  expect(state.signatures).toHaveLength(2);
  expect(state.transactions).toEqual([]);
});

test("rejected signature preserves draft and never sends PATCH", async ({ page }) => {
  const state = await setup(page, { reject: true });
  await state.drawer.getByLabel("Comentário do vendedor", { exact: true }).fill("Keep my draft");
  await state.drawer.getByRole("button", { name: "Assinar e salvar", exact: true }).click();
  await expect(
    state.drawer.getByText("Assinatura cancelada. Nada foi alterado.", { exact: true }),
  ).toBeVisible();
  await expect(state.drawer.getByLabel("Comentário do vendedor", { exact: true })).toHaveValue(
    "Keep my draft",
  );
  expect(state.patches).toEqual([]);
  expect(state.transactions).toEqual([]);
});

test("conflict refresh preserves draft and requires review before new signature", async ({
  page,
}) => {
  const state = await setup(page, { conflict: true });
  await state.drawer.getByLabel("Comentário do vendedor", { exact: true }).fill("Keep my draft");
  await state.drawer.getByRole("button", { name: "Assinar e salvar", exact: true }).click();
  await state.drawer.getByRole("button", { name: "Atualizar anúncio", exact: true }).click();
  const save = state.drawer.getByRole("button", { name: "Assinar e salvar", exact: true });
  await expect(save).toBeDisabled();
  await expect(state.drawer.getByLabel("Comentário do vendedor", { exact: true })).toHaveValue(
    "Keep my draft",
  );
  await expect(
    state.drawer.getByText("Updated in another tab", { exact: true }).last(),
  ).toBeVisible();
  expect(state.signatures).toHaveLength(1);
  await state.drawer
    .getByRole("button", { name: "Revisei. Manter meu texto", exact: true })
    .click();
  await save.click();
  await expect(state.drawer.getByText("Comentário atualizado.", { exact: true })).toBeVisible();
  expect(state.patches.map((patch) => patch.expectedRevision)).toEqual([0, 1]);
  expect(state.transactions).toEqual([]);
});

test("wallet change during signature aborts the edit before PATCH", async ({ page }) => {
  const state = await setup(page, { hold: true });
  await state.drawer.getByLabel("Comentário do vendedor", { exact: true }).fill("Do not submit");
  await state.drawer.getByRole("button", { name: "Assinar e salvar", exact: true }).click();
  await expect.poll(() => state.signatures.length).toBe(1);
  await expect(state.drawer.getByLabel("Comentário do vendedor", { exact: true })).toBeDisabled();
  await page.evaluate(() =>
    (window as unknown as { changeCommentWallet(): void }).changeCommentWallet(),
  );
  await expect(
    state.drawer.getByLabel("Comentário do vendedor", { exact: true }),
  ).not.toBeVisible();
  state.releaseSignature();
  await page.waitForTimeout(300);
  expect(state.patches).toEqual([]);
  expect(state.transactions).toEqual([]);
});

test.describe("mobile comment editor", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test("long comment stays inside bottom drawer", async ({ page }) => {
    const state = await setup(page);
    const text = state.drawer.getByLabel("Comentário do vendedor", { exact: true });
    await text.fill("NotaDoVendedor".repeat(20).slice(0, 280));
    await text.evaluate((element) => element.scrollIntoView({ block: "center" }));
    expect(
      await state.drawer.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    const save = state.drawer.getByRole("button", { name: "Assinar e salvar", exact: true });
    await expect(save).toBeEnabled();
    await expect
      .poll(() =>
        save.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const target = document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          );
          return target === element || (!!target && element.contains(target));
        }),
      )
      .toBe(true);
    await page.screenshot({ path: "/tmp/gnars-comment-editor-mobile.png", animations: "disabled" });
    expect(state.signatures).toEqual([]);
    expect(state.transactions).toEqual([]);
  });
});
