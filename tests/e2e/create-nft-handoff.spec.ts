import { expect, test, type Page } from "@playwright/test";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  multicall3Abi,
  toFunctionSelector,
  type Hex,
} from "viem";

const owner = "0x1111111111111111111111111111111111111111";
const other = "0x3333333333333333333333333333333333333333";
const contract = "0x2222222222222222222222222222222222222222";
const storageKey = `gnars:create-nft:8453:${contract}:${owner}`;
const journal = {
  account: owner,
  contract,
  requestId: `0x${"44".repeat(32)}`,
  uri: `ipfs://${"a".repeat(46)}`,
  name: "Fresh artwork",
};

async function setup(
  page: Page,
  options: {
    completed?: boolean;
    failed?: boolean;
    pending?: boolean;
    mismatch?: boolean;
    hold?: boolean;
  } = {},
) {
  const writes: string[] = [];
  let current = owner;
  let mintReads = 0;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function rpc({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
    if (/send|sign|personal_/i.test(method)) {
      writes.push(method);
      throw new Error("Wallet writes forbidden in handoff tests");
    }
    if (["eth_accounts", "eth_requestAccounts"].includes(method)) return [current];
    if (method === "eth_chainId") return "0x2105";
    if (method === "net_version") return "8453";
    if (method === "wallet_getPermissions") return [{ parentCapability: "eth_accounts" }];
    if (method === "wallet_getCapabilities") return {};
    if (method === "eth_getCode") return "0x";
    if (method === "eth_getBalance") return "0xde0b6b3a7640000";
    if (method === "eth_blockNumber") return "0x2710";
    if (method === "eth_getTransactionCount") return "0x0";
    if (method === "eth_call") {
      const data = (params?.[0] as { data?: string })?.data ?? "";
      if (data.startsWith("0x82ad56cb")) {
        const decoded = decodeFunctionData({ abi: multicall3Abi, data: data as Hex });
        if (decoded.functionName === "aggregate3") {
          const results = await Promise.all(
            decoded.args[0].map(async (call) => ({
              success: true,
              returnData: (await rpc({
                method: "eth_call",
                params: [{ to: call.target, data: call.callData }],
              })) as Hex,
            })),
          );
          return encodeFunctionResult({
            abi: multicall3Abi,
            functionName: "aggregate3",
            result: results,
          });
        }
      }
      if (data.startsWith(toFunctionSelector("mintedRequests(address,bytes32)"))) {
        mintReads++;
        if (options.hold) await held;
        return encodeAbiParameters([{ type: "uint256" }], [options.pending ? 0n : 1n]);
      }
      if (data.startsWith(toFunctionSelector("creators(uint256)")))
        return encodeAbiParameters([{ type: "address" }], [options.mismatch ? other : owner]);
      if (data.startsWith(toFunctionSelector("tokenURI(uint256)")))
        return encodeAbiParameters([{ type: "string" }], [journal.uri]);
      return `0x${"0".repeat(64)}`;
    }
    return null;
  }
  await page.exposeFunction("creationHandoffRpc", rpc);
  await page.addInitScript(
    ({ saved, key }) => {
      localStorage.setItem("gnars:view-as", "eoa");
      if (!sessionStorage.getItem("creation-handoff-seeded")) {
        localStorage.setItem(key, JSON.stringify(saved));
        sessionStorage.setItem("creation-handoff-seeded", "1");
      }
      const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
      const provider = {
        isMetaMask: true,
        request: (input: unknown) =>
          (
            window as unknown as { creationHandoffRpc(input: unknown): Promise<unknown> }
          ).creationHandoffRpc(input),
        on(event: string, callback: (...args: unknown[]) => void) {
          (listeners[event] ??= []).push(callback);
          return provider;
        },
        removeListener(event: string, callback: (...args: unknown[]) => void) {
          listeners[event] = (listeners[event] ?? []).filter((value) => value !== callback);
          return provider;
        },
      };
      Object.defineProperty(window, "ethereum", { value: provider, configurable: true });
      Object.assign(window, {
        switchCreationWallet: () =>
          listeners.accountsChanged?.forEach((callback) =>
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
          new CustomEvent("eip6963:announceProvider", {
            detail: Object.freeze({ info, provider }),
          }),
        );
      window.addEventListener("eip6963:requestProvider", announce);
      announce();
    },
    {
      key: storageKey,
      saved: {
        ...journal,
        ...(options.completed ? { tokenId: "1" } : {}),
        ...(options.failed ? { failed: true } : {}),
      },
    },
  );
  await page.route("**/*", async (route) => {
    const request = route.request();
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
        const result = await Promise.all(
          inputs.map(async (input) => ({ jsonrpc: "2.0", id: input.id, result: await rpc(input) })),
        );
        return route.fulfill({ json: Array.isArray(body) ? result : result[0] });
      }
    }
    const path = new URL(request.url()).pathname;
    if (path === "/api/create-nft/status")
      return route.fulfill({ json: { ready: true, address: contract } });
    if (path.includes("/api/ens")) return route.fulfill({ json: { ens: null, address: null } });
    if (path.startsWith("/api/marketplace"))
      return route.fulfill({
        json: { items: [], available: true, nextCursor: null, sources: {}, capabilities: {} },
      });
    if (request.method() === "POST") return route.abort("blockedbyclient");
    return route.continue();
  });
  await page.goto("/pt-br/create-nft");
  await page
    .getByRole("button", { name: /conectar|connect/i })
    .last()
    .click();
  await page.getByRole("button", { name: /connect a wallet/i }).click();
  await page.getByRole("button", { name: /metamask/i }).click();
  await expect(page.getByRole("dialog", { name: "Connect Wallet", exact: true })).not.toBeVisible({
    timeout: 30000,
  });
  return {
    writes,
    reads: () => mintReads,
    confirm: () => {
      options.pending = false;
    },
    release,
    switchWallet: async () => {
      current = other;
      await page.evaluate(() =>
        (window as unknown as { switchCreationWallet(): void }).switchCreationWallet(),
      );
    },
  };
}

test.setTimeout(60000);
test("verified recovered mint opens listing once, persisted completion does not reopen", async ({
  page,
}) => {
  const state = await setup(page);
  await expect(page).toHaveURL(
    new RegExp(`/pt-br/marketplace\\?createCollection=${contract}&createTokenId=1`),
    { timeout: 30000 },
  );
  expect(
    JSON.parse((await page.evaluate((key) => localStorage.getItem(key), storageKey)) ?? "{}")
      .tokenId,
  ).toBe("1");
  expect(state.writes).toEqual([]);
  await page.goto("/pt-br/create-nft");
  await expect(
    page.getByRole("link", { name: "Anunciar no marketplace", exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(1800);
  await expect(page).toHaveURL(/\/pt-br\/create-nft$/);
});

for (const mode of ["completed", "failed", "pending", "mismatch"] as const) {
  test(`${mode} journal does not automatically open listing`, async ({ page }) => {
    const state = await setup(page, { [mode]: true });
    await page.waitForTimeout(2500);
    await expect(page).toHaveURL(/\/pt-br\/create-nft$/);
    expect(state.writes).toEqual([]);
    if (mode === "completed" || mode === "failed") expect(state.reads()).toBe(0);
    else expect(state.reads()).toBeGreaterThan(0);
  });
}

test("manual pending confirmation opens listing only after verification finishes", async ({
  page,
}) => {
  const state = await setup(page, { pending: true });
  await expect.poll(state.reads).toBeGreaterThan(0);
  await expect(page).toHaveURL(/\/pt-br\/create-nft$/);
  state.confirm();
  await page.getByRole("button", { name: "Verificar transação", exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`/pt-br/marketplace\\?createCollection=${contract}&createTokenId=1`),
    { timeout: 30000 },
  );
  expect(state.writes).toEqual([]);
});

test("wallet changed during verification never receives the old account handoff", async ({
  page,
}) => {
  const state = await setup(page, { hold: true });
  await expect.poll(state.reads).toBeGreaterThan(0);
  await state.switchWallet();
  await page.waitForTimeout(300);
  state.release();
  await page.waitForTimeout(1800);
  await expect(page).toHaveURL(/\/pt-br\/create-nft$/);
  expect(state.writes).toEqual([]);
});
