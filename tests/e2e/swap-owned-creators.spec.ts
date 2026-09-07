import { expect, test, type Page } from "@playwright/test";
import type { WalletToken } from "../../src/app/[locale]/swap/chains";
import type { SwapTokenDirectory } from "../../src/lib/swap-token-directory";

const account = "0x6666666666666666666666666666666666666666";
const otherAccount = "0x7777777777777777777777777777777777777777";
const ownedZora = "0x1111111111111111111111111111111111111111";
const ownedClanker = "0x2222222222222222222222222222222222222222";
const zeroBalance = "0x3333333333333333333333333333333333333333";
const trendingZora = "0x4444444444444444444444444444444444444444";
const trendingClanker = "0x5555555555555555555555555555555555555555";

const holdings: WalletToken[] = [
  {
    address: ownedZora,
    name: "Meu token Zora fora do ranking",
    symbol: "MYZORA",
    decimals: 18,
    balance: "1000",
    displayBalance: "1000",
    logoUrl: "/gnars.webp",
    usdValue: 50,
  },
  {
    address: ownedClanker,
    name: "Meu token Clanker fora do ranking",
    symbol: "MYCLANK",
    decimals: 18,
    balance: "30",
    displayBalance: "30",
    logoUrl: null,
    usdValue: 250,
  },
  {
    address: zeroBalance,
    name: "Token sem saldo",
    symbol: "ZERO",
    decimals: 18,
    balance: "0",
    displayBalance: "0",
    logoUrl: null,
    usdValue: 0,
  },
];
const directory: SwapTokenDirectory = {
  tokens: [
    {
      address: trendingZora,
      name: "Zora em destaque",
      symbol: "TOPZORA",
      decimals: 18,
      category: "creator",
      source: "zora",
    },
    {
      address: trendingClanker,
      name: "Clanker em destaque",
      symbol: "TOPCLANK",
      decimals: 18,
      category: "creator",
      source: "clanker",
    },
  ],
  sources: {
    zora: { available: true },
    clanker: { available: true },
    stocks: { available: true },
  },
};

type RpcInput = { method: string; params?: unknown[]; id?: number };

async function setup(
  page: Page,
  options: { sourceFailure?: "http" | "partial"; knownOwned?: boolean } = {},
) {
  let activeAccount = account;
  const requests = { directory: 0, sources: [] as string[], portfolio: [] as string[] };
  const refusedWrites: string[] = [];
  const rpc = async ({ method }: RpcInput): Promise<unknown> => {
    if (["eth_accounts", "eth_requestAccounts"].includes(method)) return [activeAccount];
    if (method === "eth_chainId") return "0x2105";
    if (method === "net_version") return "8453";
    if (method === "wallet_getPermissions") return [{ parentCapability: "eth_accounts" }];
    if (method === "wallet_getCapabilities") return {};
    if (/^wallet_(switchEthereumChain|addEthereumChain|requestPermissions)$/.test(method))
      return null;
    // Every wallet and HTTP RPC path rejects writes, even if a new UI path is introduced.
    if (/send|sign|personal_/i.test(method)) {
      refusedWrites.push(method);
      throw new Error("Read-only test wallet refuses signing and broadcasting");
    }
    if (method === "eth_getBalance") return "0xde0b6b3a7640000";
    if (method === "eth_getCode") return "0x";
    if (method === "eth_blockNumber") return "0x2710";
    if (method === "eth_getTransactionCount") return "0x0";
    if (method === "eth_getLogs") return [];
    if (method === "eth_call") return `0x${"0".repeat(64)}`;
    throw new Error(`Unsupported mock RPC method: ${method}`);
  };
  await page.exposeFunction("swapCreatorTestRpc", rpc);
  await page.addInitScript(() => {
    localStorage.setItem("gnars:view-as", "eoa");
    localStorage.setItem("theme", "dark");
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    const provider = {
      isMetaMask: true,
      request: (input: unknown) =>
        (
          window as unknown as { swapCreatorTestRpc(input: unknown): Promise<unknown> }
        ).swapCreatorTestRpc(input),
      on(event: string, callback: (...args: unknown[]) => void) {
        (listeners[event] ??= []).push(callback);
        return provider;
      },
      removeListener(event: string, callback: (...args: unknown[]) => void) {
        listeners[event] = (listeners[event] ?? []).filter((fn) => fn !== callback);
        return provider;
      },
    };
    window.addEventListener("swap-test-account", (event) => {
      const address = (event as CustomEvent<string>).detail;
      for (const listener of listeners.accountsChanged ?? []) listener([address]);
    });
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
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/swap/tokens") {
      requests.directory += 1;
      await route.fulfill({
        json: options.knownOwned
          ? {
              ...directory,
              tokens: [
                ...directory.tokens,
                {
                  address: ownedZora,
                  symbol: holdings[0].symbol,
                  name: holdings[0].name,
                  decimals: 18,
                  category: "creator",
                  source: "zora",
                },
              ],
            }
          : directory,
      });
      return;
    }
    if (url.pathname === "/api/swap/token-sources") {
      requests.sources.push(request.url());
      if (requests.sources.length === 1 && options.sourceFailure) {
        await route.fulfill(
          options.sourceFailure === "http"
            ? { status: 503, json: { error: "Provider unavailable" } }
            : { json: { tokens: [], complete: false } },
        );
        return;
      }
      await route.fulfill({
        json: {
          tokens: [
            { address: ownedZora, source: "zora" },
            { address: ownedClanker, source: "clanker" },
          ],
          complete: true,
        },
      });
      return;
    }
    if (url.pathname === "/api/wallet/pioneer-tokens") {
      requests.portfolio.push(url.searchParams.get("address") ?? "");
      await route.fulfill({
        json: url.searchParams.get("address")?.toLowerCase() === account ? holdings : [],
      });
      return;
    }
    if (url.pathname === "/api/coins/meta") {
      await route.fulfill({ json: { coin: null, source: null } });
      return;
    }
    if (url.pathname.startsWith("/api/ens")) {
      await route.fulfill({ json: { ens: null, address: null } });
      return;
    }
    if (request.method() === "POST") {
      let payload: unknown;
      try {
        payload = request.postDataJSON();
      } catch {
        /* Non-JSON application requests are not RPC. */
      }
      const inputs = Array.isArray(payload) ? payload : [payload];
      if (
        inputs.every(
          (input) => input && typeof input === "object" && "method" in input && "jsonrpc" in input,
        )
      ) {
        const responses = await Promise.all(
          inputs.map(async (input: RpcInput) => {
            try {
              return { jsonrpc: "2.0", id: input.id, result: await rpc(input) };
            } catch (error) {
              return {
                jsonrpc: "2.0",
                id: input.id,
                error: { code: -32601, message: String(error) },
              };
            }
          }),
        );
        await route.fulfill({ json: Array.isArray(payload) ? responses : responses[0] });
        return;
      }
      if (url.origin !== new URL(page.url()).origin) {
        await route.abort("blockedbyclient");
        return;
      }
    }
    await route.continue();
  });
  await page.goto("/pt-br/swap", { waitUntil: "domcontentloaded" });
  const connect = page.getByRole("button", { name: "Conectar", exact: true });
  await expect(async () => {
    if (!(await page.getByRole("button", { name: /connect a wallet/i }).isVisible()))
      await connect.click();
    await expect(page.getByRole("button", { name: /connect a wallet/i })).toBeVisible({
      timeout: 2000,
    });
  }).toPass({ timeout: 20000 });
  await page.getByRole("button", { name: /connect a wallet/i }).click();
  await page.getByRole("button", { name: /metamask/i }).click();
  await expect.poll(() => requests.portfolio).toContain(account);
  await expect(page.getByRole("button", { name: /metamask/i })).not.toBeVisible();
  return {
    requests,
    refusedWrites,
    async switchAccount() {
      activeAccount = otherAccount;
      await page.evaluate((address) => {
        window.dispatchEvent(new CustomEvent("swap-test-account", { detail: address }));
      }, otherAccount);
    },
  };
}

async function openPicker(page: Page, side: "venda" | "compra" = "venda") {
  await page.getByRole("button", { name: `Token de ${side}`, exact: true }).click();
  const picker = page.getByTestId("token-picker");
  await expect(picker).toBeVisible();
  return picker;
}

for (const mobile of [false, true]) {
  test(`owned non-trending Zora and Clanker tokens precede discovery ${mobile ? "mobile" : "desktop"}`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const wallet = await setup(page);
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    expect(wallet.requests.directory).toBe(0);
    expect(wallet.requests.sources).toHaveLength(0);
    const picker = await openPicker(page);
    if (mobile) await picker.getByRole("tab", { name: "Criadores", exact: true }).click();
    const creators = picker.getByTestId("token-column-creator");
    const rows = creators.getByTestId("token-picker-row");
    const addresses = () =>
      rows.evaluateAll((elements) => elements.map((el) => el.getAttribute("data-token-address")));
    await expect.poll(addresses).toEqual([ownedClanker, ownedZora, trendingZora, trendingClanker]);
    await expect(creators.locator(`[data-token-address="${ownedClanker}"]`)).toContainText("30");
    await expect(creators.locator(`[data-token-address="${ownedZora}"]`)).toContainText("1.000");
    expect(wallet.requests.sources).toHaveLength(1);
    expect(wallet.requests.sources[0]).not.toContain(zeroBalance);
    await page.screenshot({
      path: `test-results/swap-owned-creators-${mobile ? "mobile" : "desktop"}.png`,
      animations: "disabled",
    });
    await creators.getByRole("button", { name: "Zora", exact: true }).click();
    await expect.poll(addresses).toEqual([ownedZora, trendingZora]);
    await creators.getByRole("button", { name: "Clanker", exact: true }).click();
    await expect.poll(addresses).toEqual([ownedClanker, trendingClanker]);
    await creators.locator(`[data-token-address="${ownedClanker}"]`).click();
    await expect(picker).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Token de venda", exact: true })).toContainText(
      holdings[1].name,
    );
    await openPicker(page, "compra");
    if (mobile) await picker.getByRole("tab", { name: "Criadores", exact: true }).click();
    await expect.poll(addresses).toEqual([ownedClanker, ownedZora, trendingZora, trendingClanker]);
    await expect(creators.locator(`[data-token-address="${ownedClanker}"]`)).toBeDisabled();
    expect(wallet.requests.directory).toBe(1);
    expect(wallet.requests.sources).toHaveLength(1);
    await wallet.switchAccount();
    await expect.poll(() => wallet.requests.portfolio).toContain(otherAccount);
    await expect.poll(addresses).toEqual([trendingZora, trendingClanker]);
    expect(wallet.refusedWrites).toEqual([]);
  });
}

for (const sourceFailure of ["http", "partial"] as const) {
  test(`creator provenance ${sourceFailure} failure preserves known holdings and discovery`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const wallet = await setup(page, { sourceFailure, knownOwned: true });
    const picker = await openPicker(page);
    const creators = picker.getByTestId("token-column-creator");
    const rows = creators.getByTestId("token-picker-row");
    const addresses = () =>
      rows.evaluateAll((elements) => elements.map((el) => el.getAttribute("data-token-address")));
    await expect(creators.getByRole("status")).toContainText("Parte do catálogo está indisponível");
    await expect.poll(addresses).toEqual([ownedZora, trendingZora, trendingClanker]);
    await expect(creators.locator(`[data-token-address="${ownedZora}"]`)).toContainText("1.000");
    await creators.getByRole("button", { name: "Tentar carregar tokens novamente" }).click();
    await expect.poll(addresses).toEqual([ownedClanker, ownedZora, trendingZora, trendingClanker]);
    await expect(creators.getByRole("status")).toHaveCount(0);
    expect(wallet.requests.sources).toHaveLength(2);
    expect(wallet.refusedWrites).toEqual([]);
  });
}
