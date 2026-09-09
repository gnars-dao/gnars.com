import { expect, test, type Page } from "@playwright/test";
import { hexToString, recoverMessageAddress, toHex, zeroAddress, zeroHash, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BUILDER_CODE } from "../../src/lib/config";
import { COMMUNITY_FEE_RECIPIENT } from "../../src/lib/marketplace/community-policy";
import {
  walletAuthorizationMessage,
  type WalletAuthorization,
} from "../../src/lib/wallet-authorization";

const PROTOCOL = "0xC35813d40961151c11C97cB9d67D0D25CD4Cc86e";
const COLLECTION = "0x4444444444444444444444444444444444444444";
const HASH = `0x${"a".repeat(64)}`;
type RpcInput = { method: string; params?: unknown[]; id?: number };

async function setup(page: Page, admin: boolean) {
  const account = privateKeyToAccount(generatePrivateKey());
  const signatures: string[] = [];
  const transactions: RpcInput[] = [];
  const moderations: Record<string, unknown>[] = [];
  const management: { url: string; authorization: WalletAuthorization }[] = [];
  const offer = {
    id: `community:${PROTOCOL}:${HASH}`,
    source: "gnars-contract",
    orderHash: HASH,
    protocolAddress: PROTOCOL,
    collectionAddress: COLLECTION,
    seller: account.address,
    priceWei: "10000000000000000",
    currency: "ETH",
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
    feePolicy: { basisPoints: 250, recipient: COMMUNITY_FEE_RECIPIENT },
    moderation: { hidden: !admin, revision: 7 },
  };
  const item = {
    tokenId: "42",
    name: "Community NFT #42",
    collectionName: "Test Community",
    collectionAddress: COLLECTION,
    image: "/gnars.webp",
    owner: account.address,
    offers: [offer],
  };
  const ready = {
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
  const rpc = async ({ method, params = [] }: RpcInput): Promise<unknown> => {
    if (["eth_accounts", "eth_requestAccounts"].includes(method)) return [account.address];
    if (method === "eth_chainId") return "0x2105";
    if (method === "net_version") return "8453";
    if (method === "wallet_getPermissions") return [{ parentCapability: "eth_accounts" }];
    if (method === "wallet_getCapabilities") return {};
    if (method.startsWith("wallet_")) return null;
    if (method === "personal_sign") {
      const raw = params[0] as Hex;
      signatures.push(hexToString(raw));
      return account.signMessage({ message: { raw } });
    }
    if (/send|sign|personal_/i.test(method)) {
      transactions.push({ method, params });
      return { __error: { code: 4001, message: "Test wallet refuses all transactions" } };
    }
    if (method === "eth_getCode") return "0x";
    if (method === "eth_getBalance") return toHex(10n ** 18n);
    if (method === "eth_blockNumber") return "0x10000";
    if (method === "eth_getTransactionCount") return "0x0";
    if (["eth_gasPrice", "eth_maxPriorityFeePerGas"].includes(method)) return "0x3b9aca00";
    if (method === "eth_getLogs") return [];
    if (method === "eth_estimateGas") return "0x30d40";
    if (method === "eth_call") return `0x${"0".repeat(64)}`;
    if (method === "eth_getTransactionReceipt" || method === "eth_getTransactionByHash")
      return null;
    if (method === "eth_getBlockByNumber")
      return {
        number: "0x10000",
        hash: zeroHash,
        parentHash: zeroHash,
        timestamp: toHex(Math.floor(Date.now() / 1000)),
        nonce: "0x0000000000000000",
        difficulty: "0x0",
        totalDifficulty: "0x0",
        gasLimit: "0x1c9c380",
        gasUsed: "0x0",
        baseFeePerGas: "0x3b9aca00",
        miner: zeroAddress,
        extraData: "0x",
        size: "0x0",
        transactions: [],
        uncles: [],
        logsBloom: `0x${"0".repeat(512)}`,
        receiptsRoot: zeroHash,
        transactionsRoot: zeroHash,
        stateRoot: zeroHash,
        sha3Uncles: zeroHash,
        mixHash: zeroHash,
      };
    return { __error: { code: -32601, message: `Unsupported test RPC ${method}` } };
  };
  await page.exposeFunction("managementTestRpc", rpc);
  await page.addInitScript(() => {
    localStorage.setItem("gnars:view-as", "eoa");
    const provider = {
      isMetaMask: true,
      async request(input: unknown) {
        const result = await (
          window as unknown as { managementTestRpc(input: unknown): Promise<unknown> }
        ).managementTestRpc(input);
        if (result && typeof result === "object" && "__error" in result) {
          const error = result.__error as { code: number; message: string };
          throw Object.assign(new Error(error.message), { code: error.code });
        }
        return result;
      },
      on() {
        return provider;
      },
      removeListener() {
        return provider;
      },
    };
    Object.defineProperty(window, "ethereum", { value: provider, configurable: true });
    const info = {
      uuid: "00000000-0000-4000-8000-000000000004",
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
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === "POST" && url.pathname === "/api/marketplace/community/moderation") {
      moderations.push(req.postDataJSON());
      return route.fulfill({ json: { hidden: true, revision: 8 } });
    }
    if (req.method() === "POST") {
      let payload: unknown;
      try {
        payload = req.postDataJSON();
      } catch {
        /* All other writes blocked below. */
      }
      const inputs = Array.isArray(payload) ? payload : [payload];
      if (
        inputs.every(
          (input) => input && typeof input === "object" && "jsonrpc" in input && "method" in input,
        )
      ) {
        const responses = await Promise.all(
          inputs.map(async (input: RpcInput) => ({
            jsonrpc: "2.0",
            id: input.id,
            result: await rpc(input),
          })),
        );
        return route.fulfill({ json: Array.isArray(payload) ? responses : responses[0] });
      }
      return route.abort("blockedbyclient");
    }
    if (url.pathname === "/api/marketplace/community/eligibility")
      return route.fulfill({
        json: {
          owner: account.address,
          balance: "0",
          minimum: 6,
          eligible: false,
          feeBps: 250,
          feeRecipient: COMMUNITY_FEE_RECIPIENT,
          canModerate: admin,
        },
      });
    if (url.pathname === "/api/marketplace/community/manage") {
      const header = req.headers()["x-wallet-authorization"];
      expect(header).toBeTruthy();
      management.push({ url: req.url(), authorization: JSON.parse(header) });
      return route.fulfill({ json: { items: [item], nextCursor: null, available: true } });
    }
    if (url.pathname === "/api/marketplace/community/moderation")
      return route.fulfill({ json: { items: [], nextCursor: null, available: true } });
    if (url.pathname === "/api/marketplace/community")
      return route.fulfill({
        json: { items: admin ? [item] : [], nextCursor: null, available: true },
      });
    if (url.pathname.startsWith("/api/marketplace/community/nfts/"))
      return route.fulfill({
        json: { ...ready, ownershipVerified: true, items: [item], nextCursor: null },
      });
    if (url.pathname.startsWith("/api/marketplace"))
      return route.fulfill({
        json: { ...ready, ownershipVerified: true, items: [], nextCursor: null },
      });
    if (url.pathname.startsWith("/api/ens"))
      return route.fulfill({ json: { ens: null, address: null } });
    return route.continue();
  });
  await page.goto("/pt-br/marketplace", { waitUntil: "domcontentloaded", timeout: 45000 });
  const owned = page.getByRole("tab", { name: "Meus Gnars", exact: true });
  await expect(async () => {
    await owned.click();
    await expect(owned).toHaveAttribute("aria-selected", "true", { timeout: 1000 });
  }).toPass({ timeout: 20000 });
  await page
    .getByRole("button", { name: /conectar|connect/i })
    .last()
    .click();
  await page.getByRole("button", { name: /connect a wallet/i }).click();
  await page.getByRole("button", { name: /metamask/i }).click();
  await expect(
    page.getByRole("button", { name: "Carregar meus anúncios da comunidade", exact: true }),
  ).toHaveCount(0);
  return { account, signatures, transactions, moderations, management };
}

test.describe("community management signing safety", () => {
  test.skip(
    process.env.MARKETPLACE_MANAGEMENT_SMOKE !== "1",
    "Requires local app with custom contract configured",
  );
  test("admin hide signs only explicit confirmation and binds exact moderation payload", async ({
    page,
  }) => {
    test.setTimeout(90000);
    const wallet = await setup(page, true);
    await page.getByRole("tab", { name: "À venda", exact: true }).click();
    await page.getByRole("button", { name: "Ver Community NFT #42", exact: true }).click();
    const drawer = page.getByRole("dialog");
    await drawer.getByRole("button", { name: "Ocultar anúncio", exact: true }).click();
    const confirm = drawer.getByRole("button", { name: "Confirmar moderação", exact: true });
    await expect(confirm).toBeDisabled();
    expect(wallet.signatures).toHaveLength(0);
    expect(wallet.moderations).toHaveLength(0);
    await drawer.getByLabel("Motivo da moderação").fill("  Conteúdo fora das regras  ");
    expect(wallet.signatures).toHaveLength(0);
    await confirm.click();
    await expect.poll(() => wallet.moderations.length).toBe(1);
    const { authorization, ...payload } = wallet.moderations[0];
    expect(payload).toEqual({
      builderCode: BUILDER_CODE,
      protocolAddress: PROTOCOL,
      orderHash: HASH,
      action: "hide",
      expectedRevision: 7,
      reason: "Conteúdo fora das regras",
    });
    const auth = authorization as WalletAuthorization;
    const message = walletAuthorizationMessage(auth, {
      method: "POST",
      path: "/api/marketplace/community/moderation",
      payload,
    });
    expect(wallet.signatures).toEqual([message]);
    expect(await recoverMessageAddress({ message, signature: auth.signature })).toBe(
      wallet.account.address,
    );
    await expect(drawer.getByText("Moderação atualizada", { exact: true })).toBeVisible();
    expect(wallet.transactions).toHaveLength(0);
    expect(wallet.signatures).toHaveLength(1);
  });
  test("zero-Gnars seller explicitly signs manage GET and can review cancellation of hidden orders", async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width: 390, height: 844 });
    const wallet = await setup(page, false);
    await page.getByRole("tab", { name: "Meus anúncios", exact: true }).click();
    const load = page.getByRole("button", {
      name: "Carregar meus anúncios da comunidade",
      exact: true,
    });
    await expect(load).toBeEnabled();
    expect(wallet.signatures).toHaveLength(0);
    expect(wallet.management).toHaveLength(0);
    await load.click();
    await expect.poll(() => wallet.management.length).toBe(1);
    const request = wallet.management[0];
    const url = new URL(request.url);
    expect(url.pathname).toBe("/api/marketplace/community/manage");
    expect(url.searchParams.has("owner")).toBe(false);
    const message = walletAuthorizationMessage(request.authorization, {
      method: "GET",
      path: url.pathname,
      payload: { cursor: null, builderCode: BUILDER_CODE, protocolAddress: PROTOCOL },
    });
    expect(wallet.signatures).toEqual([message]);
    expect(
      await recoverMessageAddress({ message, signature: request.authorization.signature }),
    ).toBe(wallet.account.address);
    await expect(page.getByText("Community NFT #42", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Oculto nos anúncios da comunidade", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Cancelar anúncio", exact: true }).click();
    await expect(page.getByRole("button", { name: "Voltar", exact: true })).toBeVisible();
    expect(wallet.signatures).toHaveLength(1);
    expect(wallet.transactions).toHaveLength(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: "/tmp/gnars-marketplace-management-mobile.png", fullPage: true });
  });
});
