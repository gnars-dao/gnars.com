import { expect, test, type Page } from "@playwright/test";
import {
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  erc721Abi,
  recoverTypedDataAddress,
  stringToHex,
  toHex,
  zeroAddress,
  zeroHash,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BUILDER_CODE, BUILDER_CODE_SUFFIX, DAO_ADDRESSES } from "../../src/lib/config";
import { OPENSEA_CONDUIT_ADDRESS, OPENSEA_CONDUIT_KEY } from "../../src/lib/marketplace/routing";
import {
  getListingCancellation,
  getListingFulfillment,
  getListingOrderHash,
  getListingTypedData,
  SEAPORT_ADDRESS,
  seaportAbi,
  validateListingStructure,
  type SignedListing,
} from "../../src/lib/marketplace/seaport";

type RpcInput = { method: string; params?: unknown[]; id?: number };

test.beforeEach(({ page }) => page.setDefaultTimeout(15000));

async function setupWallet(
  page: Page,
  options: {
    retryPublication?: boolean;
    restorePendingApproval?: boolean;
    legacyApproval?: boolean;
    legacySignedListing?: boolean;
    confirmTransactions?: boolean;
    requireApproval?: boolean;
    staleApprovalAfterBroadcast?: boolean;
    rejectCancellation?: boolean;
    buying?: boolean;
    missingCancelReceipt?: boolean;
    restoreCancelled?: boolean;
    corruptJournal?: boolean;
    rejectPublication?: boolean;
    holdConfirmation?: boolean;
    revertPurchase?: boolean;
    existingListing?: boolean;
  } = {},
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
  let approved = !options.requireApproval;
  let staleApprovalReads = 0;
  let approvedOperator = options.legacyApproval ? SEAPORT_ADDRESS : OPENSEA_CONDUIT_ADDRESS;
  let cancelled = false;
  let filled = false;
  let holdConfirmation = !!options.holdConfirmation;
  let nftOwner = account.address;
  const receipts = new Map<string, Record<string, unknown>>();
  const sentTransactions = new Map<string, Record<string, unknown>>();
  if (
    options.buying ||
    options.restoreCancelled ||
    options.legacySignedListing ||
    options.existingListing
  ) {
    const seller = options.buying ? privateKeyToAccount(generatePrivateKey()) : account;
    nftOwner = seller.address;
    const parameters: SignedListing["parameters"] = {
      offerer: seller.address,
      zone: zeroAddress,
      offer: [
        {
          itemType: 2,
          token: DAO_ADDRESSES.token,
          identifierOrCriteria: "42",
          startAmount: "1",
          endAmount: "1",
        },
      ],
      consideration: [
        {
          itemType: 0,
          token: zeroAddress,
          identifierOrCriteria: "0",
          startAmount: "9900000000000000",
          endAmount: "9900000000000000",
          recipient: seller.address,
        },
        {
          itemType: 0,
          token: zeroAddress,
          identifierOrCriteria: "0",
          startAmount: "100000000000000",
          endAmount: "100000000000000",
          recipient: feeRecipient,
        },
      ],
      orderType: 0,
      startTime: String(Math.floor(Date.now() / 1000) - 60),
      endTime: String(Math.floor(Date.now() / 1000) + 86400),
      zoneHash: zeroHash,
      salt: "123456",
      conduitKey: zeroHash,
      counter: "0",
    };
    listed = { parameters, signature: await seller.signTypedData(getListingTypedData(parameters)) };
  }
  const initialOrderHash = listed && getListingOrderHash(listed.parameters);

  if (options.corruptJournal)
    await page.addInitScript((key) => localStorage.setItem(key, "{broken saved order"), journalKey);
  if (options.legacySignedListing && listed) {
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
      key: journalKey,
      value: {
        version: 1,
        account: account.address,
        id: "legacy-zero-conduit-order",
        kind: "list",
        phase: "saving",
        tokenId: "42",
        listing: listed,
        signatureRequestSettled: true,
        input: { tokenId: "42", source: "opensea", priceEth: "0.01", durationDays: 7 },
        error: { code: "OPENSEA_CONDUIT_INVALID", retryable: false },
      },
    });
  }
  if (options.restoreCancelled && listed) {
    cancelled = true;
    const call = getListingCancellation(listed, { source: "opensea" });
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
      key: journalKey,
      value: {
        version: 1,
        account: account.address,
        id: "confirmed-cancel-missing-receipt",
        kind: "cancel",
        phase: "pending",
        tokenId: "42",
        listing: listed,
        txHash: approvalHash,
        txStep: "cancel",
        offer: {
          source: "opensea",
          seller: account.address,
          orderHash: getListingOrderHash(listed.parameters),
        },
        transactionIntent: { account: account.address, ...call, value: "0", startedBlock: "9000" },
      },
    });
  }

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
            args: [approvedOperator, 42n],
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
    // All broadcasts terminate in this in-memory ledger, never an external RPC.
    if (method === "eth_sendTransaction" && options.confirmTransactions) {
      const tx = params[0] as { from: string; to: string; data: `0x${string}`; value?: string };
      transactions.push({ method, params });
      expect(tx.from.toLowerCase()).toBe(account.address.toLowerCase());
      expect(tx.data.endsWith(BUILDER_CODE_SUFFIX.slice(2))).toBe(true);
      if (tx.to.toLowerCase() === DAO_ADDRESSES.token.toLowerCase()) {
        const decoded = decodeFunctionData({ abi: erc721Abi, data: tx.data });
        expect(decoded.functionName).toBe("approve");
        expect(String(decoded.args?.[0]).toLowerCase()).toBe(OPENSEA_CONDUIT_ADDRESS);
        expect(decoded.args?.[1]).toBe(42n);
        approved = true;
        approvedOperator = OPENSEA_CONDUIT_ADDRESS;
        staleApprovalReads = options.staleApprovalAfterBroadcast ? 1 : 0;
      } else {
        expect(tx.to.toLowerCase()).toBe(SEAPORT_ADDRESS.toLowerCase());
        const decoded = decodeFunctionData({ abi: seaportAbi, data: tx.data });
        if (decoded.functionName === "cancel") {
          if (options.rejectCancellation)
            throw Object.assign(new Error("User rejected cancellation"), { code: 4001 });
          cancelled = true;
        } else {
          expect(decoded.functionName).toBe("fulfillOrder");
          expect(BigInt(tx.value ?? "0")).toBe(10000000000000000n);
          expect(cancelled || filled).toBe(false);
          filled = true;
          nftOwner = account.address;
        }
      }
      const hash = `0x${transactions.length.toString(16).padStart(64, "0")}`;
      sentTransactions.set(hash, {
        ...tx,
        hash,
        input: tx.data,
        value: tx.value ?? "0x0",
        nonce: "0x0",
        type: "0x2",
        chainId: "0x2105",
        blockNumber: `0x${(10000 + transactions.length).toString(16)}`,
        blockHash: zeroHash,
        transactionIndex: "0x0",
        gas: "0x30d40",
        gasPrice: "0x3b9aca00",
        maxFeePerGas: "0x3b9aca00",
        maxPriorityFeePerGas: "0x3b9aca00",
        r: zeroHash,
        s: zeroHash,
        v: "0x1",
        accessList: [],
      });
      receipts.set(hash, {
        transactionHash: hash,
        transactionIndex: "0x0",
        blockHash: zeroHash,
        blockNumber: `0x${(10000 + transactions.length).toString(16)}`,
        from: tx.from,
        to: tx.to,
        cumulativeGasUsed: "0x5208",
        gasUsed: "0x5208",
        contractAddress: null,
        logs: [],
        logsBloom: `0x${"0".repeat(512)}`,
        status: options.revertPurchase && options.buying ? "0x0" : "0x1",
        effectiveGasPrice: "0x3b9aca00",
        type: "0x2",
      });
      return hash;
    }
    if (/send|sign|personal_/i.test(method)) {
      transactions.push({ method, params });
      throw Object.assign(new Error("Test wallet refuses transaction broadcasting"), {
        code: 4001,
      });
    }
    if (method === "eth_getCode") return "0x";
    if (method === "eth_getTransactionReceipt")
      return options.missingCancelReceipt && cancelled
        ? null
        : (receipts.get(String(params[0])) ?? null);
    if (method === "eth_getTransactionByHash" && filled && holdConfirmation)
      throw Object.assign(new Error("Temporary confirmation RPC outage"), { code: -32000 });
    if (method === "eth_getTransactionByHash")
      return sentTransactions.get(String(params[0])) ?? null;
    if (method === "eth_getBalance") return "0xde0b6b3a7640000";
    if (method === "eth_blockNumber") return `0x${(10000 + transactions.length).toString(16)}`;
    if (method === "eth_getTransactionCount") return "0x0";
    if (method === "eth_gasPrice" || method === "eth_maxPriorityFeePerGas") return "0x3b9aca00";
    if (method === "eth_estimateGas") return "0x30d40";
    if (method === "eth_getLogs") return [];
    if (method === "eth_getBlockByNumber")
      return {
        number: `0x${(10000 + transactions.length).toString(16)}`,
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
            result: nftOwner,
          });
        if (decoded.functionName === "getApproved") {
          const stale = staleApprovalReads > 0;
          if (stale) staleApprovalReads--;
          return encodeFunctionResult({
            abi: erc721Abi,
            functionName: "getApproved",
            result: approved && !stale ? approvedOperator : zeroAddress,
          });
        }
        if (decoded.functionName === "balanceOf")
          return encodeFunctionResult({ abi: erc721Abi, functionName: "balanceOf", result: 0n });
        if (decoded.functionName === "isApprovedForAll")
          return encodeFunctionResult({
            abi: erc721Abi,
            functionName: "isApprovedForAll",
            result:
              !options.requireApproval &&
              decoded.args[1].toLowerCase() === approvedOperator.toLowerCase(),
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
            result: [
              false,
              cancelled && (!options.existingListing || decoded.args[0] === initialOrderHash),
              filled ? 1n : 0n,
              filled ? 1n : 0n,
            ],
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

  await page.exposeFunction("marketplaceTestRpc", async (input: RpcInput) => {
    try {
      return { result: await rpc(input) };
    } catch (error) {
      const failure = error as Error & { code?: number | string };
      return { error: { message: failure.message, code: failure.code } };
    }
  });
  await page.addInitScript(() => {
    localStorage.setItem("gnars:view-as", "eoa");
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    const provider = {
      isMetaMask: true,
      request: async (input: unknown) => {
        const response = await (
          window as unknown as {
            marketplaceTestRpc(
              input: unknown,
            ): Promise<{ result?: unknown; error?: { message: string; code?: number | string } }>;
          }
        ).marketplaceTestRpc(input);
        if (response.error)
          throw Object.assign(new Error(response.error.message), { code: response.error.code });
        return response.result;
      },
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
    seller: listing.parameters.offerer,
    priceWei: listing.parameters.consideration
      .reduce((sum, item) => sum + BigInt(item.startAmount), 0n)
      .toString(),
    currency: "ETH",
    expiresAt: Number(listing.parameters.endTime),
  });
  const data = () => ({
    ownershipVerified: true,
    items: [
      {
        tokenId: "42",
        name: "Gnar #42",
        image: "/gnars.webp",
        owner: nftOwner,
        offers:
          listed &&
          (!cancelled ||
            (options.existingListing &&
              getListingOrderHash(listed.parameters) !== initialOrderHash)) &&
          !filled
            ? [offer(listed)]
            : [],
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
        const listing = validateListingStructure(request.postDataJSON().listing, {
          source: "opensea",
        });
        expect(listing.parameters.conduitKey).toBe(OPENSEA_CONDUIT_KEY);
        expect(
          toHex(BigInt(listing.parameters.salt), { size: 32 }).startsWith(
            stringToHex(BUILDER_CODE),
          ),
        ).toBe(true);
        expect(
          (
            await recoverTypedDataAddress({
              ...getListingTypedData(listing.parameters),
              signature: listing.signature,
            })
          ).toLowerCase(),
        ).toBe(account.address.toLowerCase());
        expect(listing.parameters.consideration.map((item) => item.startAmount)).toEqual(
          options.existingListing
            ? ["19800000000000000", "200000000000000"]
            : ["9900000000000000", "100000000000000"],
        );
        publications.push(listing);
        if (options.rejectPublication)
          await route.fulfill({
            status: 422,
            json: {
              error: "OpenSea rejected the order's fee configuration.",
              code: "OPENSEA_FEE_INVALID",
              retryable: false,
              requestId: "test-fee-rejection",
            },
          });
        else if (options.retryPublication && publications.length === 1)
          await route.fulfill({
            status: 503,
            json: {
              error: "Publication not confirmed",
              code: "PUBLICATION_UNCONFIRMED",
              retryable: true,
              requestId: "test-publication",
            },
          });
        else {
          listed = listing;
          await route.fulfill({ json: { offer: offer(listing) } });
        }
      } else if (path.endsWith("/fulfillment") && listed) {
        const call = getListingFulfillment(listed, { source: "opensea" });
        await route.fulfill({
          json: {
            offer: offer(listed),
            transaction: { ...call, value: call.value.toString(), chainId: 8453 },
          },
        });
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
    state: () => ({ approved, cancelled, filled, nftOwner }),
    releaseConfirmation: () => {
      holdConfirmation = false;
    },
  };
}

async function connectAndInspect(page: Page, buying = false) {
  // Development SSR includes uncached listing-provider reads before hydration.
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
  if (buying) {
    await page.getByRole("tab", { name: "À venda", exact: true }).click();
    await page.getByRole("button", { name: "Atualizar anúncios", exact: true }).click();
  }
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
  test(`listing edit cancels before replacement ${mobile ? "mobile" : "desktop"}`, async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    const wallet = await setupWallet(page, { existingListing: true, confirmTransactions: true });
    const drawer = await connectAndInspect(page);
    await drawer.getByRole("button", { name: "Editar anúncio", exact: true }).click();
    await drawer.getByLabel("Preço (ETH)", { exact: true }).fill("0.02");
    await drawer.getByLabel("Novo prazo, a partir da publicação").selectOption("30");
    const cancel = drawer.getByRole("button", { name: "Cancelar ordem atual para substituir" });
    await expect(cancel).toBeEnabled();
    expect(wallet.signedRequests).toHaveLength(0);
    expect(wallet.publications).toHaveLength(0);
    await cancel.click();
    const publish = drawer.getByRole("button", { name: "Revisar e assinar substituição" });
    await expect(publish).toBeEnabled({ timeout: 45000 });
    expect(wallet.state().cancelled).toBe(true);
    expect(wallet.publications).toHaveLength(0);
    await publish.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/gnars-listing-edit-${mobile ? "mobile" : "desktop"}.png` });
    await publish.click();
    await expect(drawer.getByText("Novo anúncio publicado.", { exact: true })).toBeVisible({
      timeout: 45000,
    });
    expect(wallet.publications).toHaveLength(1);
    expect(wallet.signedRequests).toHaveLength(1);
    expect(wallet.transactions).toHaveLength(1);
    expect(
      Number(wallet.publications[0].parameters.endTime) - Math.floor(Date.now() / 1000),
    ).toBeGreaterThan(29 * 86400);
    const draftCount = await page.evaluate(
      () => Object.keys(localStorage).filter((key) => key.startsWith("gnars:listing-edit:")).length,
    );
    expect(draftCount).toBe(0);
    expect(wallet.rpcErrors).toEqual([]);
  });
}

test("listing edit rejected cancellation preserves draft without signing replacement", async ({
  page,
}) => {
  test.setTimeout(90000);
  const wallet = await setupWallet(page, { existingListing: true, rejectCancellation: true });
  const drawer = await connectAndInspect(page);
  await drawer.getByRole("button", { name: "Editar anúncio", exact: true }).click();
  await drawer.getByLabel("Preço (ETH)", { exact: true }).fill("0.02");
  await drawer.getByRole("button", { name: "Cancelar ordem atual para substituir" }).click();
  await expect(
    drawer.getByRole("button", { name: "Cancelar ordem atual para substituir" }),
  ).toBeEnabled({ timeout: 30000 });
  expect(wallet.state().cancelled).toBe(false);
  expect(wallet.signedRequests).toHaveLength(0);
  expect(wallet.publications).toHaveLength(0);
  const drafts = await page.evaluate(() =>
    Object.keys(localStorage)
      .filter((key) => key.startsWith("gnars:listing-edit:"))
      .map((key) => JSON.parse(localStorage.getItem(key)!)),
  );
  expect(drafts).toHaveLength(1);
  expect(drafts[0].price).toBe("0.02");
});

for (const mobile of [false, true]) {
  test(`connected OpenSea listing and owner cancellation review ${mobile ? "mobile" : "desktop"}`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    const wallet = await setupWallet(page, { confirmTransactions: true });
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
    await page.screenshot({
      path: `test-results/marketplace-sell-${mobile ? "mobile" : "desktop"}.png`,
      fullPage: false,
    });
    await expect(drawer.getByRole("button", { name: "Fechar", exact: true })).toBeInViewport();
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
    await drawer.getByRole("button", { name: "Confirmar cancelamento", exact: true }).click();
    await expect.poll(() => wallet.state().cancelled).toBe(true);
    await expect(drawer.getByRole("button", { name: "Concluído", exact: true })).toBeVisible();
    expect(wallet.transactions).toHaveLength(1);
  });
}

test("NFT approval confirms before signing and publishing", async ({ page }) => {
  test.setTimeout(90000);
  const wallet = await setupWallet(page, {
    confirmTransactions: true,
    requireApproval: true,
    staleApprovalAfterBroadcast: true,
  });
  const drawer = await connectAndOpen(page);
  await drawer.getByRole("button", { name: "Revisar e assinar anúncio", exact: true }).click();
  await expect(drawer.getByRole("button", { name: "Concluído", exact: true })).toBeVisible({
    timeout: 25000,
  });
  expect(wallet.state().approved).toBe(true);
  expect(wallet.transactions).toHaveLength(1);
  expect(wallet.signedRequests).toHaveLength(1);
  expect(wallet.publications).toHaveLength(1);
});

test("cancelled order recovers without a receipt or another transaction", async ({ page }) => {
  test.setTimeout(90000);
  const wallet = await setupWallet(page, { restoreCancelled: true });
  await connectAndInspect(page);
  await expect
    .poll(async () =>
      page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).phase, wallet.journalKey),
    )
    .toBe("complete");
  expect(wallet.transactions).toHaveLength(0);
  expect(wallet.signedRequests).toHaveLength(0);
});

test("corrupt saved order exposes recovery without deleting signed data", async ({ page }) => {
  test.setTimeout(90000);
  const wallet = await setupWallet(page, { corruptJournal: true });
  const drawer = await connectAndInspect(page);
  await expect(
    drawer.getByRole("heading", { name: "Solicitação salva precisa de recuperação" }),
  ).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Exportar registro" })).toBeVisible();
  await drawer.getByRole("button", { name: "Recuperar solicitação" }).click();
  expect(await page.evaluate((key) => localStorage.getItem(key), wallet.journalKey)).toBe(
    "{broken saved order",
  );
  expect(wallet.transactions).toHaveLength(0);
  expect(wallet.signedRequests).toHaveLength(0);
});

test("buyer confirms an OpenSea purchase and sees completed ownership", async ({ page }) => {
  test.setTimeout(90000);
  const wallet = await setupWallet(page, { confirmTransactions: true, buying: true });
  const drawer = await connectAndInspect(page, true);
  await drawer.getByRole("button", { name: "Comprar", exact: true }).click();
  await drawer.getByRole("button", { name: "Confirmar compra", exact: true }).click();
  await expect.poll(() => wallet.state().filled).toBe(true);
  await expect(drawer.getByRole("button", { name: "Concluído", exact: true })).toBeVisible({
    timeout: 25000,
  });
  expect(wallet.state().nftOwner).toBe(wallet.account.address);
  expect(wallet.transactions).toHaveLength(1);
});

for (const mobile of [false, true]) {
  test(`purchase confirmation retries reads without another send ${mobile ? "mobile" : "desktop"}`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    const wallet = await setupWallet(page, {
      confirmTransactions: true,
      buying: true,
      holdConfirmation: true,
    });
    const drawer = await connectAndInspect(page, true);
    await drawer.getByRole("button", { name: "Comprar", exact: true }).click();
    await drawer.getByRole("button", { name: "Confirmar compra", exact: true }).click();
    await expect(
      drawer.getByRole("heading", { name: "Confirmando compra", exact: true }),
    ).toBeVisible();
    await expect(drawer.getByText("0.01 ETH", { exact: true })).toBeVisible();
    await expect
      .poll(async () =>
        page.evaluate(
          (key) => JSON.parse(localStorage.getItem(key)!)?.error?.code,
          wallet.journalKey,
        ),
      )
      .toBe("CONFIRMATION_PENDING");
    await expect(drawer.getByRole("alert")).toHaveCount(0);
    await page.screenshot({
      path: `test-results/purchase-confirming-${mobile ? "mobile" : "desktop"}.png`,
      fullPage: true,
    });
    expect(wallet.transactions).toHaveLength(1);
    expect(wallet.signedRequests).toHaveLength(0);
    wallet.releaseConfirmation();
    await expect(
      drawer.getByRole("heading", { name: "Compra confirmada", exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await expect(drawer.getByText("0.01 ETH", { exact: true })).toBeVisible();
    expect(wallet.transactions).toHaveLength(1);
  });
}

test("purchase confirmation resumes after reload without another wallet request", async ({
  page,
}) => {
  test.setTimeout(90000);
  const wallet = await setupWallet(page, {
    confirmTransactions: true,
    buying: true,
    holdConfirmation: true,
  });
  const drawer = await connectAndInspect(page, true);
  await drawer.getByRole("button", { name: "Comprar", exact: true }).click();
  await drawer.getByRole("button", { name: "Confirmar compra", exact: true }).click();
  await expect
    .poll(async () =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)!)?.error?.code,
        wallet.journalKey,
      ),
    )
    .toBe("CONFIRMATION_PENDING");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Confirmando compra", exact: true })).toBeVisible({
    timeout: 30000,
  });
  wallet.releaseConfirmation();
  await expect
    .poll(
      async () =>
        page.evaluate((key) => JSON.parse(localStorage.getItem(key)!)?.phase, wallet.journalKey),
      { timeout: 30000 },
    )
    .toBe("complete");
  expect(wallet.transactions).toHaveLength(1);
  expect(wallet.signedRequests).toHaveLength(0);
});

test("verified purchase revert remains a failure instead of automatic success", async ({
  page,
}) => {
  test.setTimeout(90000);
  const wallet = await setupWallet(page, {
    confirmTransactions: true,
    buying: true,
    revertPurchase: true,
  });
  const drawer = await connectAndInspect(page, true);
  await drawer.getByRole("button", { name: "Comprar", exact: true }).click();
  await drawer.getByRole("button", { name: "Confirmar compra", exact: true }).click();
  await expect
    .poll(
      async () =>
        page.evaluate((key) => JSON.parse(localStorage.getItem(key)!)?.phase, wallet.journalKey),
      { timeout: 30000 },
    )
    .toBe("failed");
  await expect(drawer.getByRole("heading", { name: "Compra confirmada", exact: true })).toHaveCount(
    0,
  );
  await expect(drawer.getByRole("alert").first()).toBeVisible();
  expect(wallet.transactions).toHaveLength(1);
});

test("rejected cancellation preserves the original signed listing", async ({ page }) => {
  test.setTimeout(90000);
  const wallet = await setupWallet(page, {
    retryPublication: true,
    confirmTransactions: true,
    rejectCancellation: true,
  });
  const drawer = await connectAndOpen(page);
  await drawer.getByRole("button", { name: "Revisar e assinar anúncio", exact: true }).click();
  await drawer.getByRole("button", { name: "Cancelar ordem assinada", exact: true }).click();
  await drawer.getByRole("button", { name: "Confirmar cancelamento", exact: true }).click();
  await expect.poll(() => wallet.transactions.length).toBe(1);
  await expect
    .poll(async () =>
      page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).listing, wallet.journalKey),
    )
    .toEqual(wallet.publications[0]);
  expect(wallet.state().cancelled).toBe(false);
  await expect(
    drawer.getByRole("button", { name: "Cancelar ordem assinada", exact: true }),
  ).toBeVisible();
  expect(wallet.signedRequests).toHaveLength(1);
});

test("permanent publication rejection keeps the order and status checks do not republish", async ({
  page,
}) => {
  test.setTimeout(90000);
  const wallet = await setupWallet(page, { rejectPublication: true });
  const drawer = await connectAndOpen(page);
  await drawer.getByRole("button", { name: "Revisar e assinar anúncio", exact: true }).click();
  await expect(drawer.getByRole("alert")).toContainText("test-fee-rejection");
  await expect(drawer.getByRole("button", { name: "Continuar anúncio", exact: true })).toHaveCount(
    0,
  );
  await expect(
    drawer.getByRole("button", { name: "Cancelar ordem assinada", exact: true }),
  ).toBeVisible();
  const status = drawer.getByRole("button", { name: /Verificar/ });
  if (await status.count()) await status.click();
  expect(wallet.publications).toHaveLength(1);
  expect(wallet.signedRequests).toHaveLength(1);
  expect(wallet.transactions).toHaveLength(0);
  expect(
    await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).listing, wallet.journalKey),
  ).toEqual(wallet.publications[0]);
});

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
  await expect(drawer.getByRole("alert").first()).toContainText(
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

test("legacy Seaport approval recovers then requires exact OpenSea conduit approval before signing", async ({
  page,
}) => {
  const wallet = await setupWallet(page, {
    restorePendingApproval: true,
    legacyApproval: true,
    confirmTransactions: true,
  });
  const drawer = await connectAndInspect(page);
  await drawer.getByRole("button", { name: "Verificar transação", exact: true }).click();
  const resume = drawer.getByRole("button", { name: "Continuar anúncio", exact: true });
  await expect(resume).toBeVisible();
  expect(wallet.signedRequests).toHaveLength(0);
  expect(wallet.transactions).toHaveLength(0);
  await resume.click();
  await expect.poll(() => wallet.publications.length).toBe(1);
  expect(wallet.transactions).toHaveLength(1);
  expect(wallet.signedRequests).toHaveLength(1);
  expect(wallet.publications[0].parameters.conduitKey).toBe(OPENSEA_CONDUIT_KEY);
});

test("legacy rejected zero-conduit signature is cancelled unchanged with the builder suffix", async ({
  page,
}) => {
  const wallet = await setupWallet(page, { legacySignedListing: true, confirmTransactions: true });
  const drawer = await connectAndInspect(page);
  const before = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!).listing,
    wallet.journalKey,
  );
  expect(before.parameters.conduitKey).toBe(zeroHash);
  await drawer.getByRole("button", { name: "Cancelar ordem assinada", exact: true }).click();
  await drawer.getByRole("button", { name: "Confirmar cancelamento", exact: true }).click();
  await expect.poll(() => wallet.state().cancelled).toBe(true);
  const after = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!).listing,
    wallet.journalKey,
  );
  expect(after).toEqual(before);
  expect(wallet.transactions).toHaveLength(1);
  expect(wallet.signedRequests).toHaveLength(0);
  expect(wallet.publications).toHaveLength(0);
});
