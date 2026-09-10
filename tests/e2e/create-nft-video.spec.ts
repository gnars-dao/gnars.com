import { readFileSync } from "node:fs";
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
const contract = "0x2222222222222222222222222222222222222222";
const png = {
  name: "cover.png",
  mimeType: "image/png",
  buffer: readFileSync("public/gnars-splash-200.png"),
};

async function setup(page: Page) {
  const writes: string[] = [];
  let uploads = 0;
  let metadataPosts = 0;
  async function rpc({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
    if (method === "personal_sign") return `0x${"11".repeat(64)}1b`;
    if (/send|sign/i.test(method)) {
      writes.push(method);
      throw new Error("Transaction or typed-data signing forbidden in video UI tests");
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
    if (method === "eth_call") {
      const data = (params?.[0] as { data?: string })?.data ?? "";
      if (data.startsWith("0x82ad56cb")) {
        const decoded = decodeFunctionData({ abi: multicall3Abi, data: data as Hex });
        if (decoded.functionName === "aggregate3") {
          return encodeFunctionResult({
            abi: multicall3Abi,
            functionName: "aggregate3",
            result: await Promise.all(
              decoded.args[0].map(async (call) => ({
                success: true,
                returnData: (await rpc({
                  method: "eth_call",
                  params: [{ to: call.target, data: call.callData }],
                })) as Hex,
              })),
            ),
          });
        }
      }
      if (data.startsWith(toFunctionSelector("balanceOf(address)")))
        return encodeAbiParameters([{ type: "uint256" }], [6n]);
      return `0x${"0".repeat(64)}`;
    }
    return null;
  }
  await page.exposeFunction("videoCreationRpc", rpc);
  await page.addInitScript(() => {
    localStorage.setItem("gnars:view-as", "eoa");
    localStorage.setItem(
      "gnars:aa-welcome-dismissed:0x1111111111111111111111111111111111111111",
      "true",
    );
    const provider = {
      isMetaMask: true,
      request: (input: unknown) =>
        (
          window as unknown as { videoCreationRpc(input: unknown): Promise<unknown> }
        ).videoCreationRpc(input),
      on() {
        return provider;
      },
      removeListener() {
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
  await page.route("**/*", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/create-nft/status")
      return route.fulfill({ json: { ready: true, address: contract } });
    if (path === "/api/pinata/signed-url") {
      uploads++;
      return route.fulfill({ status: 503, json: { error: "Mock upload unavailable" } });
    }
    if (path === "/api/create-nft/metadata") {
      metadataPosts++;
      return route.abort("blockedbyclient");
    }
    if (path.includes("/api/ens")) return route.fulfill({ json: { ens: null, address: null } });
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
          inputs.map(async (input) => ({
            jsonrpc: "2.0",
            id: input.id,
            result: await rpc(input),
          })),
        );
        return route.fulfill({ json: Array.isArray(body) ? result : result[0] });
      }
      return route.abort("blockedbyclient");
    }
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
  await page.getByLabel("Nome", { exact: true }).fill("Gnars video");
  await page.getByRole("checkbox").check();
  return { writes, uploads: () => uploads, metadataPosts: () => metadataPosts };
}

test.setTimeout(90000);

for (const width of [1440, 390]) {
  test(`MP4 requires decoded cover and upload failure never mints ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const state = await setup(page);
    const mint = page.getByRole("button", { name: "Criar na Base", exact: true });
    await page.locator("#nft-artwork").setInputFiles("tests/fixtures/nft-preview.mp4");
    const video = page.locator("main video");
    await expect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState))
      .toBeGreaterThanOrEqual(2);
    expect(await video.evaluate((element: HTMLVideoElement) => element.videoWidth)).toBeGreaterThan(
      0,
    );
    await expect(video).toHaveJSProperty("paused", true);
    await expect(video).toHaveJSProperty("controls", true);
    await expect(mint).toBeDisabled();
    await page.getByLabel("Imagem de capa (obrigatória)").setInputFiles(png);
    await expect(mint).toBeEnabled();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `/tmp/create-nft-video-${width}.png`, fullPage: true });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    ).toBeTruthy();

    await page
      .locator("#nft-cover")
      .setInputFiles({ name: "bad.txt", mimeType: "text/plain", buffer: Buffer.from("bad") });
    await expect(mint).toBeDisabled();
    await expect(page.locator('main p[role="alert"]')).toContainText("Escolha uma capa");
    await page.locator("#nft-cover").setInputFiles(png);
    await expect(mint).toBeEnabled();
    await mint.click();
    await expect(page.locator('main p[role="alert"]')).toContainText("O envio não foi concluído");
    expect(state.uploads()).toBe(1);
    expect(state.metadataPosts()).toBe(0);
    expect(state.writes).toEqual([]);
    expect(
      await page.evaluate(() =>
        Object.keys(localStorage).filter((key) => key.startsWith("gnars:create-nft:")),
      ),
    ).toEqual([]);
  });
}

test("image flow needs no cover and invalid replacement cannot reuse previous media", async ({
  page,
}) => {
  const state = await setup(page);
  const mint = page.getByRole("button", { name: "Criar na Base", exact: true });
  await page.locator("#nft-artwork").setInputFiles(png);
  await expect(mint).toBeEnabled();
  await expect(page.locator("#nft-cover")).toHaveCount(0);
  await page
    .locator("#nft-artwork")
    .setInputFiles({ name: "bad.txt", mimeType: "text/plain", buffer: Buffer.from("bad") });
  await expect(mint).toBeDisabled();
  await expect(page.locator('main p[role="alert"]')).toContainText("Escolha uma imagem válida");
  await page.locator("#nft-artwork").setInputFiles({
    name: "broken.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.from("not an MP4"),
  });
  await expect(page.locator('main p[role="alert"]')).toContainText("Escolha uma imagem válida");
  await page.locator("#nft-cover").setInputFiles(png);
  await expect(mint).toBeDisabled();
  expect(state.uploads()).toBe(0);
  expect(state.writes).toEqual([]);
});
