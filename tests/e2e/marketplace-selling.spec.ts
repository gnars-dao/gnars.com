import { expect, test, type Page } from "@playwright/test";
import {
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  erc721Abi,
  zeroAddress,
  zeroHash,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DAO_ADDRESSES } from "../../src/lib/config";
import {
  getListingOrderHash,
  SEAPORT_ADDRESS,
  seaportAbi,
  type SignedListing,
} from "../../src/lib/marketplace/seaport";

type RpcInput = { method: string; params?: unknown[]; id?: number };

test.beforeEach(({ page }) => page.setDefaultTimeout(15000));

async function setupWallet(
  page: Page,
  options: { retryPublication?: boolean; restorePendingApproval?: boolean } = {},
) {
  const account = privateKeyToAccount(generatePrivateKey());
  const signedRequests: unknown[] = [];
  const publications: SignedListing[] = [];
  const transactions: unknown[] = [];
  const rpcErrors: string[] = [];
  const feeRecipient = "0x2222222222222222222222222222222222222222";
  const approvalHash = `0x${"a".repeat(64)}`;
  const journalKey = `gnars:marketplace:v1:8453:${account.address.toLowerCase()}`;
  let listed: SignedListing | undefined;

  if (options.restorePendingApproval) {
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
      key: journalKey,
      value: {
        version: 1,
        account: account.address,
        id: "pending-approval-e2e",
        kind: "list",
        phase: "pending",
        tokenId: "42",
        txStep: "approval",
        txHash: approvalHash,
        input: {
          tokenId: "42",
          priceEth: "0.01",
          durationDays: 7,
          source: "opensea",
          expectedRoyaltyWei: "0",
          expectedQuote: {
            source: "opensea",
            priceWei: "10000000000000000",
            sellerWei: "9900000000000000",
            royaltyWei: "0",
            royaltyRecipient: null,
            fees: [{ recipient: feeRecipient, basisPoints: 100, amountWei: "100000000000000" }],
          },
        },
        transactionIntent: {
          account: account.address,
          to: DAO_ADDRESSES.token,
          value: "0",
          startedBlock: "9000",
          data: encodeFunctionData({
            abi: erc721Abi,
            functionName: "approve",
            args: [SEAPORT_ADDRESS, 42n],
          }),
        },
      },
    });
  }

  async function rpc({ method, params = [] }: RpcInput): Promise<unknown> {
    if (["eth_accounts", "eth_requestAccounts"].includes(method)) return [account.address];
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
    if (method === "eth_signTypedData_v4") {
      const typed = typeof params[1] === "string" ? JSON.parse(params[1]) : params[1];
      signedRequests.push(typed);
      return account.signTypedData(typed as never);
    }
    // No transaction can escape this harness, including from an unexpected wallet path.
    if (/send|sign|personal_/i.test(method)) {
      transactions.push({ method, params });
      throw Object.assign(new Error("Test wallet refuses transaction broadcasting"), {
        code: 4001,
      });
    }
    if (method === "eth_getCode") return "0x";
    if (method === "eth_getTransactionReceipt" || method === "eth_getTransactionByHash")
      return null;
    if (method === "eth_getBalance") return "0xde0b6b3a7640000";
    if (method === "eth_blockNumber") return "0x2710";
    if (method === "eth_getTransactionCount") return "0x0";
    if (method === "eth_gasPrice" || method === "eth_maxPriorityFeePerGas") return "0x3b9aca00";
    if (method === "eth_estimateGas") return "0x30d40";
    if (method === "eth_getLogs") return [];
    if (method === "eth_getBlockByNumber")
      return {
        number: "0x2710",
        hash: zeroHash,
        parentHash: zeroHash,
        timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
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
    if (method === "eth_call") {
      const call = params[0] as { data?: `0x${string}` };
      try {
        const decoded = decodeFunctionData({ abi: erc721Abi, data: call.data ?? "0x" });
        if (decoded.functionName === "ownerOf")
          return encodeFunctionResult({
            abi: erc721Abi,
            functionName: "ownerOf",
            result: account.address,
          });
        if (decoded.functionName === "getApproved")
          return encodeFunctionResult({
            abi: erc721Abi,
            functionName: "getApproved",
            result: SEAPORT_ADDRESS,
          });
        if (decoded.functionName === "balanceOf")
          return encodeFunctionResult({ abi: erc721Abi, functionName: "balanceOf", result: 0n });
        if (decoded.functionName === "isApprovedForAll")
          return encodeFunctionResult({
            abi: erc721Abi,
            functionName: "isApprovedForAll",
            result: true,
          });
      } catch {
        /* Other contract ABIs are handled below. */
      }
      try {
        const decoded = decodeFunctionData({ abi: seaportAbi, data: call.data ?? "0x" });
        if (decoded.functionName === "getCounter")
          return encodeFunctionResult({ abi: seaportAbi, functionName: "getCounter", result: 0n });
        if (decoded.functionName === "getOrderStatus")
          return encodeFunctionResult({
            abi: seaportAbi,
            functionName: "getOrderStatus",
            result: [false, false, 0n, 0n],
          });
        if (decoded.functionName === "getOrderHash")
          return encodeFunctionResult({
            abi: seaportAbi,
            functionName: "getOrderHash",
            result: getListingOrderHash(decoded.args[0] as never),
          });
        if (decoded.functionName === "cancel")
          return encodeFunctionResult({ abi: seaportAbi, functionName: "cancel", result: true });
      } catch {
        /* Wallet factory and unrelated navigation reads receive zero below. */
      }
      return `0x${"0".repeat(64)}`;
    }
    rpcErrors.push(method);
    throw new Error(`Unsupported mock RPC method: ${method}`);
  }

  await page.exposeFunction("marketplaceTestRpc", rpc);
  await page.addInitScript(() => {
    localStorage.setItem("gnars:view-as", "eoa");
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    const provider = {
      isMetaMask: true,
      request: (input: unknown) =>
        (
          window as unknown as { marketplaceTestRpc(input: unknown): Promise<unknown> }
        ).marketplaceTestRpc(input),
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

  const offer = (listing: SignedListing) => ({
    id: `opensea:${getListingOrderHash(listing.parameters)}`,
    source: "opensea",
    orderHash: getListingOrderHash(listing.parameters),
    protocolAddress: SEAPORT_ADDRESS,
    seller: account.address,
    priceWei: "10000000000000000",
    currency: "ETH",
    expiresAt: Number(listing.parameters.endTime),
  });
  const data = () => ({
    items: [
      {
        tokenId: "42",
        name: "Gnar #42",
        image: "/gnars.webp",
        owner: account.address,
        offers: listed ? [offer(listed)] : [],
      },
    ],
    nextCursor: null,
    sources: {
      catalogue: { available: true },
      opensea: { available: true },
      gnars: { available: false, error: "not_configured" },
    },
    capabilities: { openseaBuy: true, openseaSell: true, openseaCancel: true, localTrading: false },
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
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
          (value) => value && typeof value === "object" && "method" in value && "jsonrpc" in value,
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
                error: {
                  code: -32601,
                  message: error instanceof Error ? error.message : "Mock RPC rejected",
                },
              };
            }
          }),
        );
        await route.fulfill({ json: Array.isArray(payload) ? responses : responses[0] });
        return;
      }
    }
    if (request.url().includes("/api/marketplace")) {
      const path = new URL(request.url()).pathname;
      if (path.endsWith("/opensea/quote")) {
        const { priceWei } = request.postDataJSON();
        const fee = BigInt(priceWei) / 100n;
        await route.fulfill({
          json: {
            quote: {
              priceWei,
              sellerWei: (BigInt(priceWei) - fee).toString(),
              fees: [{ recipient: feeRecipient, basisPoints: 100, amountWei: fee.toString() }],
            },
          },
        });
      } else if (path.endsWith("/opensea/orders")) {
        const listing = request.postDataJSON().listing as SignedListing;
        publications.push(listing);
        if (options.retryPublication && publications.length === 1)
          await route.fulfill({ status: 503, json: { error: "Temporary test provider failure" } });
        else {
          listed = listing;
          await route.fulfill({ json: { offer: offer(listing) } });
        }
      } else if (path.includes("/opensea/orders/") && listed) {
        await route.fulfill({
          json: {
            order: {
              chain: "base",
              order_hash: getListingOrderHash(listed.parameters),
              protocol_address: SEAPORT_ADDRESS,
              protocol_data: listed,
            },
          },
        });
      } else await route.fulfill({ json: data() });
      return;
    }
    if (request.url().includes("/api/ens")) {
      await route.fulfill({ json: { ens: null, address: null } });
      return;
    }
    if (
      request.method() === "POST" &&
      new URL(request.url()).origin !== new URL(page.url()).origin
    ) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  return {
    account,
    signedRequests,
    publications,
    transactions,
    rpcErrors,
    journalKey,
    approvalHash,
  };
}

async function connectAndInspect(page: Page) {
  await page.goto("/pt-br/marketplace", { waitUntil: "domcontentloaded" });
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
  await expect(page.getByRole("button", { name: "Ver Gnar #42", exact: true })).toBeVisible({
    timeout: 30000,
  });
  await page.getByRole("button", { name: "Ver Gnar #42", exact: true }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  return drawer;
}

async function connectAndOpen(page: Page) {
  const drawer = await connectAndInspect(page);
  await drawer.getByRole("button", { name: "Anunciar", exact: true }).click();
  await drawer.getByLabel("Preço (ETH)", { exact: true }).fill("0,01");
  await expect(drawer.getByText("Taxas obrigatórias da OpenSea", { exact: true })).toBeVisible();
  await expect(drawer.getByText("0.0001 ETH", { exact: true })).toBeVisible();
  await expect(drawer.getByText("0.0099 ETH", { exact: true })).toBeVisible();
  return drawer;
}

for (const mobile of [false, true]) {
  test(`connected OpenSea listing and owner cancellation review ${mobile ? "mobile" : "desktop"}`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    const wallet = await setupWallet(page);
    const drawer = await connectAndOpen(page);
    await expect(drawer).toHaveAttribute("data-vaul-drawer-direction", mobile ? "bottom" : "right");
    await test.info().attach("drawer-focus-layout", {
      body: JSON.stringify(
        await drawer.evaluate((el) => ({
          bounds: el.getBoundingClientRect().toJSON(),
          scrollTop: el.scrollTop,
          scrollBodyTop: el.querySelector("[data-vaul-no-drag]")?.scrollTop,
          close: el.querySelector('[aria-label="Fechar"]')?.getBoundingClientRect().toJSON(),
          windowScroll: window.scrollY,
          transform: getComputedStyle(el).transform,
        })),
      ),
      contentType: "application/json",
    });
    expect(
      await drawer
        .locator("[data-vaul-no-drag]")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await expect(drawer.getByRole("button", { name: "Fechar", exact: true })).toBeInViewport();
    await page.screenshot({
      path: `test-results/marketplace-sell-${mobile ? "mobile" : "desktop"}.png`,
      fullPage: false,
    });
    await drawer.getByRole("button", { name: "Revisar e assinar anúncio", exact: true }).click();
    await expect(drawer.getByRole("button", { name: "Concluído", exact: true })).toBeVisible({
      timeout: 20000,
    });
    expect(wallet.signedRequests).toHaveLength(1);
    expect(wallet.publications).toHaveLength(1);
    expect(wallet.transactions).toHaveLength(0);
    expect(wallet.publications[0].parameters.offer[0].token.toLowerCase()).toBe(
      DAO_ADDRESSES.token.toLowerCase(),
    );
    await drawer.getByRole("button", { name: "Concluído", exact: true }).click();
    await expect(drawer).toHaveCount(0);
    await expect(async () => {
      await page.getByRole("button", { name: "Ver Gnar #42", exact: true }).click();
      await expect(drawer).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 5000 });
    await drawer.getByRole("button", { name: "Cancelar anúncio", exact: true }).click();
    await expect(
      drawer.getByRole("button", { name: "Confirmar cancelamento", exact: true }),
    ).toBeEnabled();
    await expect(
      drawer.getByText(
        "Cancelar este anúncio na Base? Ele continua válido até a confirmação do cancelamento.",
      ),
    ).toBeVisible();
  });
}

test("OpenSea publication retry reuses the exact signed order without another wallet signature", async ({
  page,
}) => {
  test.setTimeout(90000);
  const wallet = await setupWallet(page, { retryPublication: true });
  const drawer = await connectAndOpen(page);
  await drawer.getByRole("button", { name: "Revisar e assinar anúncio", exact: true }).click();
  await expect(drawer.getByRole("button", { name: "Continuar anúncio", exact: true })).toBeVisible({
    timeout: 20000,
  });
  expect(wallet.signedRequests).toHaveLength(1);
  expect(wallet.publications).toHaveLength(1);
  await expect(drawer.getByRole("alert").first()).toHaveText(
    "Não foi possível confirmar a publicação. Seu anúncio assinado está salvo. Continue para verificar e tentar publicar com a mesma assinatura.",
  );
  await drawer.getByRole("button", { name: "Cancelar ordem assinada", exact: true }).click();
  await expect(
    drawer.getByText(
      "Cancelar esta ordem assinada na Base, mesmo sem confirmação da publicação? Pode haver taxa de rede. A ordem só é revogada após a confirmação.",
    ),
  ).toBeVisible();
  await expect(
    drawer.getByRole("button", { name: "Confirmar cancelamento", exact: true }),
  ).toBeEnabled();
  await drawer.getByRole("button", { name: "Voltar", exact: true }).click();
  await drawer.getByRole("button", { name: "Continuar anúncio", exact: true }).click();
  await expect(drawer.getByRole("button", { name: "Concluído", exact: true })).toBeVisible({
    timeout: 20000,
  });
  expect(wallet.publications).toHaveLength(2);
  expect(wallet.publications[1]).toEqual(wallet.publications[0]);
  expect(wallet.signedRequests).toHaveLength(1);
  expect(wallet.transactions).toHaveLength(0);
});

test("pending NFT approval recovers from confirmed state without another approval or automatic signature", async ({
  page,
}) => {
  test.setTimeout(90000);
  const wallet = await setupWallet(page, { restorePendingApproval: true });
  const drawer = await connectAndInspect(page);
  await expect(drawer.getByRole("button", { name: "Anunciar", exact: true })).toBeDisabled();
  await drawer.getByRole("button", { name: "Verificar transação", exact: true }).click();
  await expect(
    drawer.getByRole("button", { name: "Continuar anúncio", exact: true }),
  ).toBeVisible();
  expect(wallet.signedRequests).toHaveLength(0);
  expect(wallet.publications).toHaveLength(0);
  expect(wallet.transactions).toHaveLength(0);
  const saved = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    wallet.journalKey,
  );
  expect(saved.phase).toBe("signing");
  expect(saved.approvalTxHash).toBe(wallet.approvalHash);
  expect(saved.txHash).toBeUndefined();
  await drawer.getByRole("button", { name: "Continuar anúncio", exact: true }).click();
  await expect.poll(() => wallet.publications.length).toBe(1);
  expect(wallet.signedRequests).toHaveLength(1);
  expect(wallet.transactions).toHaveLength(0);
  await expect
    .poll(async () =>
      page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).phase, wallet.journalKey),
    )
    .toBe("complete");
});
