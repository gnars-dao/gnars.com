import { expect, test, type Page } from "@playwright/test";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  parseEther,
  toHex,
  zeroAddress,
  zeroHash,
  type Hex,
} from "viem";
import { BUILDER_CODE_SUFFIX, DAO_ADDRESSES, MARKETPLACE_CONFIG } from "../../src/lib/config";
import { getListingOrderHash, type SignedListing } from "../../src/lib/marketplace/seaport";
import { getSweepFulfillment, sweepAbi, type SweepQuote } from "../../src/lib/marketplace/sweep";

const protocol = "0xC35813d40961151c11C97cB9d67D0D25CD4Cc86e";
const buyer = "0x1111111111111111111111111111111111111111";
const seller = "0x2222222222222222222222222222222222222222";
const hash = `0x${"a".repeat(64)}` as Hex;
const journalKey = `gnars:marketplace:v1:8453:${buyer}`;

function fixture(): SweepQuote {
  const now = Math.floor(Date.now() / 1000);
  const listings: SignedListing[] = ["42", "43"].map((id) => ({
    parameters: {
      offerer: seller,
      zone: zeroAddress,
      zoneHash: zeroHash,
      conduitKey: zeroHash,
      offer: [
        {
          itemType: 2,
          token: DAO_ADDRESSES.token,
          identifierOrCriteria: id,
          startAmount: "1",
          endAmount: "1",
        },
      ],
      consideration: [
        {
          itemType: 0,
          token: zeroAddress,
          identifierOrCriteria: "0",
          startAmount: parseEther("0.0099").toString(),
          endAmount: parseEther("0.0099").toString(),
          recipient: seller,
        },
        {
          itemType: 0,
          token: zeroAddress,
          identifierOrCriteria: "0",
          startAmount: parseEther("0.0001").toString(),
          endAmount: parseEther("0.0001").toString(),
          recipient: MARKETPLACE_CONFIG.communityFeeRecipient,
        },
      ],
      orderType: 0,
      startTime: String(now - 1),
      endTime: String(now + 86400),
      salt: id,
      counter: "0",
    },
    signature: "0x1234",
  }));
  return {
    protocolAddress: protocol,
    expiresAt: now + 90,
    totalWei: parseEther("0.02").toString(),
    listings,
    items: listings.map((listing) => ({
      tokenId: listing.parameters.offer[0].identifierOrCriteria,
      name: `Gnar #${listing.parameters.offer[0].identifierOrCriteria}`,
      image: "/gnars.webp",
      owner: seller,
      offers: [
        {
          id: "fixture",
          source: "gnars-contract",
          protocolAddress: protocol,
          orderHash: getListingOrderHash(listing.parameters),
          seller,
          priceWei: parseEther("0.01").toString(),
          currency: "ETH",
          expiresAt: now + 86400,
        },
      ],
    })),
  };
}

async function setup(page: Page, mode: "reject" | "unknown" = "reject", ownOnly = false) {
  const quote = fixture();
  const inventory = ownOnly
    ? quote.items.map((item) => ({
        ...item,
        owner: buyer,
        offers: item.offers.map((offer) => ({ ...offer, seller: buyer })),
      }))
    : quote.items;
  const prompts: Array<{ method: string; params: unknown[] }> = [];
  const quoteRequests: unknown[] = [];
  let quoteFails = false;
  const call = getSweepFulfillment(quote.listings);
  const event = sweepAbi.find((entry) => entry.type === "event")!;
  const first = quote.listings[0];
  const topics = encodeEventTopics({
    abi: sweepAbi,
    eventName: "OrderFulfilled",
    args: { offerer: seller, zone: zeroAddress },
  });
  const eventData = encodeAbiParameters(
    event.inputs.filter((input) => !("indexed" in input && input.indexed)),
    [
      getListingOrderHash(first.parameters),
      buyer,
      first.parameters.offer.map((item) => ({
        itemType: item.itemType,
        token: item.token,
        identifier: BigInt(item.identifierOrCriteria),
        amount: 1n,
      })),
      first.parameters.consideration.map((item) => ({
        itemType: item.itemType,
        token: item.token,
        identifier: 0n,
        amount: BigInt(item.startAmount),
        recipient: item.recipient,
      })),
    ],
  );
  const rpc = async ({ method, params = [] }: { method: string; params?: unknown[] }) => {
    if (["eth_accounts", "eth_requestAccounts"].includes(method)) return [buyer];
    if (method === "eth_chainId") return "0x2105";
    if (method === "net_version") return "8453";
    if (method === "wallet_getCapabilities") return {};
    if (method === "wallet_getPermissions") return [{ parentCapability: "eth_accounts" }];
    if (method.startsWith("wallet_")) return null;
    if (/send|sign|personal_/i.test(method)) {
      prompts.push({ method, params });
      return {
        __error: {
          code: mode === "reject" ? 4001 : -32000,
          message: "Test wallet never broadcasts",
        },
      };
    }
    if (method === "eth_getCode") return "0x";
    if (method === "eth_getBalance") return toHex(parseEther("1"));
    if (method === "eth_blockNumber") return "0x10000";
    if (method === "eth_getTransactionCount") return "0x0";
    if (["eth_gasPrice", "eth_maxPriorityFeePerGas"].includes(method)) return "0x3b9aca00";
    if (method === "eth_estimateGas") return "0x50000";
    if (method === "eth_getLogs") return [];
    if (method === "eth_call")
      return encodeFunctionResult({
        abi: sweepAbi,
        functionName: "fulfillAvailableOrders",
        result: [[true, true], []],
      });
    if (method === "eth_getTransactionByHash")
      return {
        hash,
        from: buyer,
        to: protocol,
        input: `${call.data}${BUILDER_CODE_SUFFIX.slice(2)}`,
        value: toHex(call.value),
        chainId: "0x2105",
        blockNumber: "0x10001",
        blockHash: zeroHash,
        transactionIndex: "0x0",
        nonce: "0x0",
        gas: "0x50000",
        gasPrice: "0x1",
        type: "0x0",
        v: "0x1b",
        r: zeroHash,
        s: zeroHash,
      };
    if (method === "eth_getTransactionReceipt")
      return {
        transactionHash: hash,
        transactionIndex: "0x0",
        blockHash: zeroHash,
        blockNumber: "0x10001",
        from: buyer,
        to: protocol,
        cumulativeGasUsed: "0x10000",
        gasUsed: "0x10000",
        effectiveGasPrice: "0x1",
        contractAddress: null,
        type: "0x0",
        status: "0x1",
        logsBloom: `0x${"0".repeat(512)}`,
        logs: [
          {
            address: protocol,
            topics,
            data: eventData,
            blockNumber: "0x10001",
            blockHash: zeroHash,
            transactionHash: hash,
            transactionIndex: "0x0",
            logIndex: "0x0",
            removed: false,
          },
        ],
      };
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
        baseFeePerGas: "0x1",
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
  await page.exposeFunction("sweepTestRpc", rpc);
  await page.addInitScript(() => {
    localStorage.setItem("gnars:view-as", "eoa");
    const provider = {
      isMetaMask: true,
      async request(input: unknown) {
        const value = await (
          window as unknown as { sweepTestRpc(input: unknown): Promise<unknown> }
        ).sweepTestRpc(input);
        if (value && typeof value === "object" && "__error" in value) {
          const error = value.__error as { code: number; message: string };
          throw Object.assign(new Error(error.message), { code: error.code });
        }
        return value;
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
      uuid: "00000000-0000-4000-8000-000000000009",
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
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === "POST") {
      if (url.pathname === "/api/marketplace/sweep/quote") {
        quoteRequests.push(req.postDataJSON());
        return route.fulfill({
          status: quoteFails ? 503 : ownOnly ? 409 : 200,
          json: quoteFails
            ? { error: "unavailable" }
            : ownOnly
              ? { code: "SWEEP_EMPTY", error: "No available floor listings." }
              : quote,
        });
      }
      if (url.pathname === "/api/marketplace/sweep/fulfillment")
        return route.fulfill({
          json: {
            listings: quote.listings,
            totalWei: quote.totalWei,
            transaction: { chainId: 8453, ...call, value: call.value.toString() },
          },
        });
      let payload;
      try {
        payload = req.postDataJSON();
      } catch {}
      const inputs = Array.isArray(payload) ? payload : [payload];
      if (
        inputs.every(
          (input) => input && typeof input === "object" && "jsonrpc" in input && "method" in input,
        )
      ) {
        const responses = await Promise.all(
          inputs.map(async (input) => {
            const result = await rpc(input);
            return {
              jsonrpc: "2.0",
              id: input.id,
              ...(result && typeof result === "object" && "__error" in result
                ? { error: result.__error }
                : { result }),
            };
          }),
        );
        return route.fulfill({ json: Array.isArray(payload) ? responses : responses[0] });
      }
      return route.abort("blockedbyclient");
    }
    if (url.pathname === "/api/marketplace/community")
      return route.fulfill({ json: { items: [], available: true, nextCursor: null } });
    if (url.pathname.startsWith("/api/marketplace"))
      return route.fulfill({
        json: { ...ready, items: inventory, nextCursor: null, ownershipVerified: true },
      });
    if (url.pathname.startsWith("/api/ens"))
      return route.fulfill({ json: { ens: null, address: null } });
    return route.continue();
  });
  await page.goto("/pt-br/marketplace", { waitUntil: "domcontentloaded" });
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  const owned = page.getByRole("tab", { name: "Meus Gnars", exact: true });
  await expect(async () => {
    await owned.click();
    await expect(owned).toHaveAttribute("aria-selected", "true", { timeout: 1000 });
  }).toPass({ timeout: 20000 });
  await page
    .getByRole("button", { name: /connect|conectar/i })
    .last()
    .click();
  await page.getByRole("button", { name: /connect a wallet/i }).click();
  await page.getByRole("button", { name: /metamask/i }).click();
  await expect(page.getByRole("link", { name: buyer, exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "À venda", exact: true }).click();
  await page.getByRole("button", { name: "Atualizar anúncios", exact: true }).click();
  await expect(page.getByRole("button", { name: "Ver Gnar #42", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Comprar floor", exact: true }).click({ timeout: 10000 });
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("button", { name: "Atualizar cotação", exact: true })).toBeVisible();
  return {
    quote,
    prompts,
    quoteRequests,
    failQuotes: (fail: boolean) => {
      quoteFails = fail;
    },
  };
}

for (const mobile of [false, true]) {
  test(`own listings stay visible but cannot be swept ${mobile ? "mobile" : "desktop"}`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    );
    const state = await setup(page, "reject", true);
    const drawer = page.getByRole("dialog");
    await expect(
      drawer.getByText("Nenhum Gnar disponível para esta carteira no contrato Gnars.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(drawer.getByText("Seus anúncios", { exact: true })).toBeVisible();
    await expect(drawer.getByText("Gnar #42", { exact: true })).toBeVisible();
    await expect(drawer.getByText("Sua carteira · fora da compra", { exact: true })).toHaveCount(2);
    await expect(drawer.getByRole("img").first()).toBeVisible();
    await expect(
      drawer.getByRole("button", { name: "Comprar até 3 NFTs", exact: true }),
    ).toBeDisabled();
    await expect(drawer.getByText("0.02 ETH", { exact: true })).toHaveCount(0);
    await expect(
      drawer.getByText("Anúncios da OpenSea e de outras coleções não entram neste lote."),
    ).toBeVisible();
    await page.screenshot({
      path: `test-results/sweep-own-listings-${mobile ? "mobile" : "desktop"}.png`,
      fullPage: true,
    });
    expect(
      await drawer
        .locator(".overflow-y-auto")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    const before = state.quoteRequests.length;
    await drawer.getByLabel("Máximo por NFT (ETH)", { exact: true }).fill("0,005");
    await expect.poll(() => state.quoteRequests.length).toBeGreaterThan(before);
    await expect(
      drawer.getByText(
        "Nenhum Gnar disponível para esta carteira no contrato Gnars dentro deste limite de preço.",
        { exact: true },
      ),
    ).toBeVisible();
    const after = state.quoteRequests.length;
    await page.waitForTimeout(1200);
    expect(state.quoteRequests).toHaveLength(after);
    expect(state.prompts).toHaveLength(0);
  });
}

for (const mobile of [false, true])
  test(`sweep review and one tagged wallet request ${mobile ? "mobile" : "desktop"}`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    );
    const state = await setup(page);
    const drawer = page.getByRole("dialog");
    await drawer.getByLabel("Quantidade", { exact: true }).fill("2");
    await drawer.getByLabel("Máximo por NFT (ETH)", { exact: true }).fill("0,02");
    await expect(
      drawer.getByRole("button", { name: "Comprar até 2 NFTs", exact: true }),
    ).toBeEnabled();
    expect(state.quoteRequests.at(-1)).toMatchObject({
      buyer,
      quantity: 2,
      maxPriceWei: parseEther("0.02").toString(),
    });
    await expect(drawer.getByText("0.02 ETH", { exact: true })).toBeVisible();
    await expect(drawer.getByText("Gnar #42", { exact: true })).toBeVisible();
    await expect(drawer.getByText("Gnar #43", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect
      .poll(() =>
        drawer
          .getByRole("img", { name: "Gnar #42", exact: true })
          .evaluate(
            (image) =>
              (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0,
          ),
      )
      .toBe(true);
    await page.screenshot({
      path: `/tmp/gnars-sweep-${mobile ? "mobile" : "desktop"}.png`,
      animations: "disabled",
    });
    await drawer.getByRole("button", { name: "Comprar até 2 NFTs", exact: true }).click();
    await expect.poll(() => state.prompts.length).toBe(1);
    expect(state.prompts[0].method).toBe("eth_sendTransaction");
    const tx = state.prompts[0].params[0] as { to: string; data: string; value: string };
    expect(tx.to.toLowerCase()).toBe(protocol.toLowerCase());
    expect(BigInt(tx.value)).toBe(parseEther("0.02"));
    expect(tx.data.toLowerCase()).toBe(
      `${getSweepFulfillment(state.quote.listings).data}${BUILDER_CODE_SUFFIX.slice(2)}`.toLowerCase(),
    );
  });

test("sweep quote failure is recoverable and cannot prompt a purchase", async ({ page }) => {
  test.setTimeout(90000);
  const state = await setup(page);
  state.failQuotes(true);
  await page.getByRole("button", { name: "Atualizar cotação", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Não foi possível confirmar",
  );
  await expect(page.getByRole("button", { name: /Comprar até \d+ NFTs/ })).toBeDisabled();
  expect(state.prompts).toHaveLength(0);
  state.failQuotes(false);
  await page.getByRole("button", { name: "Atualizar cotação", exact: true }).click();
  await expect(page.getByRole("button", { name: "Comprar até 2 NFTs", exact: true })).toBeEnabled();
});

test("unknown sweep survives reload and partial receipt recovery never sends again", async ({
  page,
}) => {
  test.setTimeout(90000);
  const state = await setup(page, "unknown");
  await page.getByRole("button", { name: "Atualizar cotação", exact: true }).click();
  await page.getByRole("button", { name: "Comprar até 2 NFTs", exact: true }).click();
  await expect.poll(() => state.prompts.length).toBe(1);
  await expect
    .poll(
      async () =>
        JSON.parse((await page.evaluate((key) => localStorage.getItem(key), journalKey)) ?? "{}")
          .phase,
    )
    .toBe("unknown");
  await page.reload({ waitUntil: "domcontentloaded" });
  const recovery = page.getByRole("region", { name: "Compra em lote: 2 NFTs", exact: true });
  await expect(recovery).toBeVisible();
  await recovery.getByLabel("Hash da transação", { exact: true }).fill(hash);
  await recovery.getByRole("button", { name: "Verificar hash", exact: true }).click();
  await expect(page.getByText("1 NFTs comprados", { exact: true })).toBeVisible();
  await expect(page.getByText(/1 NFTs não comprados/)).toContainText("#43");
  expect(state.prompts).toHaveLength(1);
  const saved = JSON.parse(
    (await page.evaluate((key) => localStorage.getItem(key), journalKey)) ?? "{}",
  );
  expect(saved.sweep.result).toEqual({
    purchasedTokenIds: ["42"],
    skippedTokenIds: ["43"],
    spentWei: parseEther("0.01").toString(),
  });
});
