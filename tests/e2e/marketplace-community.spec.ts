import { expect, test, type Page } from "@playwright/test";
import { zeroAddress } from "viem";
import { COMMUNITY_FEE_RECIPIENT } from "../../src/lib/marketplace/community-policy";
import { buildCommunityListingQuote } from "../../src/lib/marketplace/listing-intent";

const owner = "0x1111111111111111111111111111111111111111";
const collection = "0x2222222222222222222222222222222222222222";
const longName =
  "Community NFT with a deliberately long name that must wrap without horizontal overflow";

async function setup(
  page: Page,
  options: {
    balance?: number;
    feeBps?: number | null;
    lookupFails?: boolean;
    eligibilityFails?: boolean;
    image?: string;
  } = {},
) {
  const writes: string[] = [];
  const quotes: unknown[] = [];
  const balance = options.balance ?? 6;
  const feeBps = options.feeBps === undefined ? 100 : options.feeBps;
  async function rpc({ method }: { method: string }) {
    if (method === "eth_accounts" || method === "eth_requestAccounts") return [owner];
    if (method === "eth_chainId") return "0x2105";
    if (method === "net_version") return "8453";
    if (
      [
        "wallet_switchEthereumChain",
        "wallet_addEthereumChain",
        "wallet_requestPermissions",
      ].includes(method)
    )
      return null;
    if (method === "wallet_getPermissions") return [{ parentCapability: "eth_accounts" }];
    if (method === "wallet_getCapabilities") return {};
    if (/send|sign|personal_/i.test(method)) {
      writes.push(method);
      throw Object.assign(new Error("Test forbids wallet writes"), { code: 4001 });
    }
    if (method === "eth_getCode") return "0x";
    if (method === "eth_getBalance") return "0xde0b6b3a7640000";
    if (method === "eth_blockNumber") return "0x2710";
    if (method === "eth_getTransactionCount") return "0x0";
    if (method === "eth_call") return `0x${"0".repeat(64)}`;
    return null;
  }
  await page.exposeFunction("communityTestRpc", rpc);
  // Same EIP-6963 injected-wallet fixture as the marketplace selling tests, with all writes refused.
  await page.addInitScript(() => {
    localStorage.setItem("gnars:view-as", "eoa");
    localStorage.setItem("theme", "dark");
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    const provider = {
      isMetaMask: true,
      request: (input: unknown) =>
        (
          window as unknown as { communityTestRpc(input: unknown): Promise<unknown> }
        ).communityTestRpc(input),
      on(event: string, callback: (...args: unknown[]) => void) {
        (listeners[event] ??= []).push(callback);
        return provider;
      },
      removeListener(event: string, callback: (...args: unknown[]) => void) {
        listeners[event] = (listeners[event] ?? []).filter((fn) => fn !== callback);
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
        new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }),
      );
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  });

  const pageData = {
    ownershipVerified: true,
    items: [],
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
  await page.route("**/*", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST") {
      let payload: unknown;
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
        await route.fulfill({ json: Array.isArray(payload) ? responses : responses[0] });
        return;
      }
    }
    if (path === "/api/marketplace/community/eligibility") {
      await route.fulfill(
        options.eligibilityFails
          ? { status: 503, json: { error: "unavailable" } }
          : {
              json: {
                owner,
                balance: String(balance),
                minimum: 6,
                eligible: balance >= 6,
                feeBps,
                feeRecipient: COMMUNITY_FEE_RECIPIENT,
                canModerate: false,
              },
            },
      );
    } else if (path.startsWith("/api/marketplace/community/nfts/")) {
      await route.fulfill(
        options.lookupFails
          ? { status: 503, json: { error: "unavailable" } }
          : {
              json: {
                ...pageData,
                items: [
                  {
                    collectionAddress: collection,
                    collectionName: "Community Collection",
                    tokenId: "42",
                    name: longName,
                    image: options.image ?? "/gnars.webp",
                    owner,
                    offers: [],
                  },
                ],
              },
            },
      );
    } else if (path === "/api/marketplace/community/quote") {
      const body = request.postDataJSON();
      quotes.push(body);
      await route.fulfill({
        json: {
          quote: buildCommunityListingQuote(
            body.priceWei,
            { amount: 0n, recipient: zeroAddress },
            { basisPoints: feeBps!, recipient: COMMUNITY_FEE_RECIPIENT },
          ),
        },
      });
    } else if (path.startsWith("/api/marketplace/community")) {
      await route.fulfill({ json: { items: [], nextCursor: null, available: true } });
    } else if (path.startsWith("/api/marketplace")) {
      await route.fulfill({ json: pageData });
    } else if (path.includes("/api/ens")) {
      await route.fulfill({ json: { ens: null, address: null } });
    } else if (
      request.method() === "POST" &&
      new URL(request.url()).origin !== new URL(page.url()).origin
    ) {
      await route.abort("blockedbyclient");
    } else await route.continue();
  });
  return { writes, quotes };
}

async function openWizard(page: Page) {
  await page.goto("/pt-br/marketplace", { waitUntil: "domcontentloaded", timeout: 45000 });
  // The development-only status badge otherwise covers the mobile drawer's back button.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await expect(page.getByRole("tab", { name: "Meus Gnars", exact: true })).toBeEnabled({
    timeout: 45000,
  });
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
  await expect(
    drawer.getByRole("heading", { name: "Anunciar NFT da comunidade", exact: true }),
  ).toBeVisible();
  return drawer;
}

async function lookup(page: Page) {
  const drawer = page.getByRole("dialog");
  await drawer.getByText("Inserir contrato e ID do token", { exact: true }).click();
  await drawer.getByLabel("Endereço do contrato NFT").fill(collection);
  await drawer.getByLabel("ID do token", { exact: true }).fill("42");
  await drawer.getByRole("button", { name: "Buscar NFT", exact: true }).click();
  return drawer;
}

test.beforeEach(({ page }) => page.setDefaultTimeout(15000));
test.setTimeout(90000);

for (const mobile of [false, true]) {
  test(`wallet auto-filled inventory shows SkateHive without manual pagination ${mobile ? "mobile" : "desktop"}`, async ({
    page,
  }) => {
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    );
    const state = await setup(page);
    const requests: URLSearchParams[] = [];
    await page.route("**/api/marketplace/community/wallet?**", async (route) => {
      requests.push(new URL(route.request().url()).searchParams);
      await route.fulfill({
        json: {
          items: ["1", "2", "3", "4", "271", "278"].map((tokenId) => ({
            collectionAddress: collection,
            tokenId,
            name: Number(tokenId) > 4 ? `SkateHive #${tokenId}` : `NFT #${tokenId}`,
            collectionName: Number(tokenId) > 4 ? "SkateHive" : "Community",
            image: "/gnars.webp",
            owner,
            offers: [],
          })),
          nextCursor: null,
          unsupportedErc1155Count: 3,
        },
      });
    });
    const drawer = await openWizard(page);
    const skatehive = drawer.getByRole("button", {
      name: "Selecionar SkateHive #271",
      exact: true,
    });
    await expect(skatehive).toBeVisible();
    await expect(
      drawer.getByRole("button", { name: "Selecionar SkateHive #278", exact: true }),
    ).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Carregar mais NFTs" })).toHaveCount(0);
    await skatehive.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        skatehive.locator("img").evaluate((img) => (img as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    expect(
      await drawer
        .locator("[data-vaul-no-drag]")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/wallet-autofill-${mobile ? "mobile" : "desktop"}.png`,
    });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((params) => !params.has("cursor") && !params.has("collection"))).toBe(
      true,
    );
    expect(state.writes).toEqual([]);
  });

  test(`wallet NFT picker paginates, retries and verifies selection ${mobile ? "mobile" : "desktop"}`, async ({
    page,
  }) => {
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    );
    const state = await setup(page);
    let failNextPage = true;
    const owners: string[] = [];
    await page.route("**/api/marketplace/community/wallet?**", async (route) => {
      const params = new URL(route.request().url()).searchParams;
      owners.push(params.get("owner")!);
      const cursor = params.get("cursor");
      if (cursor && failNextPage) {
        await route.fulfill({ status: 503, json: { error: "unavailable" } });
        return;
      }
      await route.fulfill({
        json: {
          items: cursor
            ? [
                {
                  collectionAddress: collection,
                  tokenId: "42",
                  name: longName,
                  collectionName: "Community Collection",
                  image: "/gnars.webp",
                  owner,
                  offers: [],
                },
              ]
            : [],
          nextCursor: cursor ? null : "next-page",
        },
      });
    });
    const drawer = await openWizard(page);
    await expect(drawer.getByRole("heading", { name: "Seus NFTs na Base" })).toBeVisible();
    await expect(
      drawer.getByText("Nenhum NFT compatível encontrado nesta carteira."),
    ).not.toBeVisible();
    await drawer.getByRole("button", { name: "Carregar mais NFTs" }).click();
    await expect(drawer.getByRole("alert")).toContainText("Não foi possível carregar os NFTs");
    failNextPage = false;
    await drawer.getByRole("button", { name: "Tentar novamente", exact: true }).click();
    const card = drawer.getByRole("button", { name: `Selecionar ${longName}`, exact: true });
    await expect(card).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    await expect
      .poll(() => card.locator("img").evaluate((img) => (img as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    expect(
      await drawer
        .locator("[data-vaul-no-drag]")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/marketplace-wallet-picker-${mobile ? "mobile" : "desktop"}.png`,
    });
    await card.click();
    await expect(drawer.getByRole("heading", { name: longName })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Continuar", exact: true })).toBeEnabled();
    await drawer.getByRole("button", { name: "Continuar", exact: true }).click();
    await expect(drawer.getByLabel("Preço (ETH)")).toBeVisible();
    expect(owners.every((address) => address.toLowerCase() === owner)).toBe(true);
    expect(state.writes).toHaveLength(0);
  });
}

test("community submission requires six Gnars and fails closed below the threshold", async ({
  page,
}) => {
  const state = await setup(page, { balance: 5 });
  const drawer = await openWizard(page);
  await expect(drawer.getByText("Você possui 5 Gnars", { exact: true })).toBeVisible();
  await expect(drawer.getByText("É preciso ter pelo menos 6 Gnars para anunciar.")).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Continuar", exact: true })).toBeDisabled();
  await expect(drawer.getByLabel("Endereço do contrato NFT")).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

for (const mobile of [false, true]) {
  test(`wallet collection search finds indexed NFTs without scanning every page ${mobile ? "mobile" : "desktop"}`, async ({
    page,
  }) => {
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    );
    const state = await setup(page);
    const skatehive = "0xfe10d3ce1b0f090935670368ec6de00d8d965523";
    const nogglesboard = "0x9580c826076bcba116ce4729ec243290c2e3b441";
    const requests: URLSearchParams[] = [];
    await page.route("**/api/marketplace/community/wallet?**", async (route) => {
      const params = new URL(route.request().url()).searchParams;
      requests.push(params);
      const selected = params.get("collection")?.toLowerCase();
      await route.fulfill({
        json: {
          items:
            selected === skatehive
              ? [
                  {
                    collectionAddress: skatehive,
                    tokenId: "271",
                    name: "SkateHive #271",
                    collectionName: "SkateHive",
                    image: "/gnars.webp",
                    owner,
                    offers: [],
                  },
                ]
              : [],
          nextCursor: selected ? null : "later-page",
          ...(selected === nogglesboard ? { unsupportedErc1155Count: 2 } : {}),
        },
      });
    });
    const drawer = await openWizard(page);
    await expect(drawer.getByRole("button", { name: "Carregar mais NFTs" })).toBeVisible();
    const filter = drawer.getByLabel("Filtrar coleção", { exact: true });
    const initialRequests = requests.length;
    await filter.fill("not-a-contract");
    await drawer.getByRole("button", { name: "Buscar coleção", exact: true }).click();
    await expect(drawer.getByRole("alert")).toContainText("Informe um endereço");
    expect(requests).toHaveLength(initialRequests);
    await filter.fill(skatehive);
    await drawer.getByRole("button", { name: "Buscar coleção", exact: true }).click();
    await expect(
      drawer.getByRole("button", { name: "Selecionar SkateHive #271", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        drawer
          .getByRole("img", { name: "SkateHive #271", exact: true })
          .evaluate((img) => (img as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    expect(requests.at(-1)?.get("cursor")).toBeNull();
    expect(requests.at(-1)?.get("owner")).toBe(owner);
    await page.screenshot({
      path: `test-results/wallet-collection-search-${mobile ? "mobile" : "desktop"}.png`,
    });
    await filter.fill(`https://opensea.io/item/base/${nogglesboard}/54`);
    await drawer.getByRole("button", { name: "Buscar coleção", exact: true }).click();
    await expect(
      drawer.getByText("NFTs ERC-1155 encontrados. Este fluxo de anúncio aceita apenas ERC-721.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      drawer.getByRole("button", { name: "Selecionar SkateHive #271", exact: true }),
    ).toHaveCount(0);
    await expect(
      drawer.getByText("Nenhum NFT compatível encontrado nesta carteira."),
    ).not.toBeVisible();
    expect(requests.at(-1)?.get("collection")?.toLowerCase()).toBe(nogglesboard);
    expect(requests.at(-1)?.get("cursor")).toBeNull();
    await drawer.getByRole("button", { name: "Limpar filtro de coleção", exact: true }).click();
    await expect(filter).toHaveValue("");
    await expect(drawer.getByRole("button", { name: "Carregar mais NFTs" })).toBeVisible();
    expect(state.writes).toEqual([]);
  });
}

for (const mobile of [false, true]) {
  test(`community NFT lookup and fee review ${mobile ? "mobile" : "desktop"}`, async ({ page }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    const state = await setup(page);
    const drawer = await openWizard(page);
    await expect(drawer).toHaveAttribute("data-vaul-drawer-direction", mobile ? "bottom" : "right");
    await expect(drawer.getByText("Você possui 6 Gnars", { exact: true })).toBeVisible();
    await lookup(page);
    await expect(drawer.getByRole("heading", { name: longName, exact: true })).toBeVisible();
    await expect(drawer.getByRole("img", { name: longName })).toBeVisible();
    if (!mobile) {
      await expect
        .poll(() =>
          drawer
            .getByRole("img", { name: longName })
            .evaluate((img) => (img as HTMLImageElement).naturalWidth),
        )
        .toBeGreaterThan(0);
    }
    await drawer.getByRole("button", { name: "Continuar", exact: true }).click();
    await drawer.getByLabel("Preço (ETH)", { exact: true }).fill("0.02");
    await expect(drawer.getByText("Taxa da comunidade (1%)", { exact: true })).toBeVisible();
    await expect(drawer.getByText("0.0002 ETH", { exact: true })).toBeVisible();
    await expect(drawer.getByText("0.0198 ETH", { exact: true })).toBeVisible();
    await expect(
      drawer.getByRole("button", { name: "Revisar e assinar anúncio", exact: true }),
    ).toBeEnabled();
    await expect
      .poll(() =>
        drawer
          .getByRole("img", { name: longName })
          .evaluate(
            (img) =>
              (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0,
          ),
      )
      .toBe(true);
    await page.screenshot({
      path: `/tmp/gnars-community-wizard-${mobile ? "mobile" : "desktop"}.png`,
    });
    const dimensions = await drawer.evaluate((el) => ({
      width: el.clientWidth,
      scrollWidth: el.scrollWidth,
    }));
    expect(dimensions.scrollWidth, JSON.stringify(dimensions)).toBeLessThanOrEqual(
      dimensions.width,
    );
    const viewport = await page.evaluate(() => ({
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(viewport.scrollWidth, JSON.stringify(viewport)).toBeLessThanOrEqual(viewport.width);
    await drawer.getByRole("button", { name: "Voltar", exact: true }).click();
    await expect(drawer.getByLabel("Endereço do contrato NFT")).toHaveValue(collection);
    await drawer.getByRole("button", { name: "Fechar", exact: true }).click();
    await expect(drawer).not.toBeVisible();
    expect(state.quotes).toContainEqual({
      collectionAddress: collection,
      tokenId: "42",
      priceWei: "20000000000000000",
    });
    expect(state.writes).toEqual([]);
  });
}

test("community NFT lookup failures cannot advance to signing", async ({ page }) => {
  const state = await setup(page, { lookupFails: true });
  const drawer = await openWizard(page);
  await lookup(page);
  await expect(drawer.getByRole("alert")).toContainText("Não foi possível verificar este NFT");
  await expect(drawer.getByRole("button", { name: "Continuar", exact: true })).toBeDisabled();
  await expect(drawer.getByRole("button", { name: "Tentar novamente", exact: true })).toBeEnabled();
  expect(state.writes).toEqual([]);
});

test("unconfigured community fees are not shown as zero or allowed to publish", async ({
  page,
}) => {
  const state = await setup(page, { feeBps: null });
  const drawer = await openWizard(page);
  await expect(
    drawer.getByText(/A taxa dos anúncios da comunidade não foi configurada/),
  ).toBeVisible();
  await lookup(page);
  await expect(drawer.getByRole("heading", { name: longName, exact: true })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Continuar", exact: true })).toBeDisabled();
  expect(state.quotes).toEqual([]);
  expect(state.writes).toEqual([]);
});

test("membership verification failures expose retry and keep submission disabled", async ({
  page,
}) => {
  const state = await setup(page, { eligibilityFails: true });
  const drawer = await openWizard(page);
  await expect(drawer.getByRole("alert")).toContainText(
    "Não foi possível verificar seu saldo de Gnars.",
  );
  await expect(drawer.getByRole("button", { name: "Tentar novamente", exact: true })).toBeEnabled();
  await expect(drawer.getByRole("button", { name: "Continuar", exact: true })).toBeDisabled();
  expect(state.writes).toEqual([]);
});

test("community preview renders live catalogue artwork without image mocks", async ({
  page,
  request,
}) => {
  test.skip(process.env.MARKETPLACE_REAL_ARTWORK_SMOKE !== "1", "Opt-in live artwork read");
  const response = await request.get("/api/marketplace?view=catalogue");
  expect(response.ok()).toBe(true);
  const catalogue = await response.json();
  const image = catalogue.items?.find((item: { image?: string }) => item.image)?.image;
  expect(image).toBeTruthy();
  const state = await setup(page, { image });
  const drawer = await openWizard(page);
  await lookup(page);
  const artwork = drawer.getByRole("img", { name: longName });
  await expect
    .poll(() => artwork.evaluate((img) => (img as HTMLImageElement).naturalWidth), {
      timeout: 30000,
    })
    .toBeGreaterThan(0);
  await page.screenshot({ path: "/tmp/gnars-community-real-artwork-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(drawer).toHaveAttribute("data-vaul-drawer-direction", "bottom");
  await artwork.scrollIntoViewIfNeeded();
  await expect(artwork).toBeVisible();
  await page.screenshot({ path: "/tmp/gnars-community-real-artwork-mobile.png" });
  expect(state.writes).toEqual([]);
});
