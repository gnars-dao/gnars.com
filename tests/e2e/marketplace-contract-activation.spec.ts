import { expect, test } from "@playwright/test";
import {
  decodeFunctionData,
  encodeFunctionResult,
  erc721Abi,
  stringToHex,
  toHex,
  zeroAddress,
  zeroHash,
} from "viem";
import {
  BUILDER_CODE,
  BUILDER_CODE_SUFFIX,
  DAO_ADDRESSES,
  MARKETPLACE_CONFIG,
} from "../../src/lib/config";
import { SEAPORT_ADDRESS, seaportAbi } from "../../src/lib/marketplace/seaport";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const CONTRACT = "0xC35813d40961151c11C97cB9d67D0D25CD4Cc86e";
type RpcInput = { method: string; params?: unknown[]; id?: number };

// Opt-in integration smoke: exercises the running app's real activation configuration.
test.describe("activated Gnars contract", () => {
  test.skip(process.env.MARKETPLACE_ACTIVATION_SMOKE !== "1", "Requires activated local server");
  for (const { approved, protocol, marketplaceName } of [false, true].flatMap((approved) => [
    { approved, protocol: CONTRACT as `0x${string}`, marketplaceName: "Contrato Gnars" },
    { approved, protocol: SEAPORT_ADDRESS, marketplaceName: "Seaport" },
  ])) {
    test(`routes ${approved ? "typed signature" : "NFT approval"} with 1% fee to ${marketplaceName}`, async ({
      page,
      request,
    }) => {
      test.setTimeout(90000);
      await page.setViewportSize(
        approved ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      );
      const ready = await (await request.get("/api/marketplace/readiness")).json();
      expect(ready.capabilities.customTrading).toBe(true);
      const prompts: RpcInput[] = [];
      const rpc = async ({ method, params = [] }: RpcInput): Promise<unknown> => {
        if (["eth_accounts", "eth_requestAccounts"].includes(method)) return [ACCOUNT];
        if (method === "eth_chainId") return "0x2105";
        if (method === "net_version") return "8453";
        if (method === "wallet_getCapabilities") return {};
        if (method === "wallet_getPermissions") return [{ parentCapability: "eth_accounts" }];
        if (method.startsWith("wallet_")) return null;
        if (/send|sign|personal_/i.test(method)) {
          prompts.push({ method, params });
          return {
            __error: {
              code: 4001,
              message: "Test wallet rejects every signing and broadcast request",
            },
          };
        }
        if (method === "eth_getCode") return "0x";
        if (method === "eth_getBalance") return toHex(10n ** 18n);
        if (method === "eth_blockNumber") return "0x10000";
        if (method === "eth_getTransactionCount") return "0x0";
        if (["eth_gasPrice", "eth_maxPriorityFeePerGas"].includes(method)) return "0x3b9aca00";
        if (method === "eth_estimateGas") return "0x30d40";
        if (method === "eth_getLogs") return [];
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
        if (method === "eth_call") {
          const call = params[0] as { data: `0x${string}`; to: string };
          try {
            const decoded = decodeFunctionData({ abi: erc721Abi, data: call.data });
            if (decoded.functionName === "ownerOf")
              return encodeFunctionResult({
                abi: erc721Abi,
                functionName: "ownerOf",
                result: ACCOUNT,
              });
            if (decoded.functionName === "getApproved")
              return encodeFunctionResult({
                abi: erc721Abi,
                functionName: "getApproved",
                result: approved ? protocol : zeroAddress,
              });
            if (decoded.functionName === "isApprovedForAll")
              return encodeFunctionResult({
                abi: erc721Abi,
                functionName: decoded.functionName,
                result: false,
              });
          } catch {
            /* Other wallet reads are handled below. */
          }
          try {
            const decoded = decodeFunctionData({ abi: seaportAbi, data: call.data });
            if (decoded.functionName === "getCounter") {
              expect(call.to.toLowerCase()).toBe(protocol.toLowerCase());
              return encodeFunctionResult({
                abi: seaportAbi,
                functionName: "getCounter",
                result: 0n,
              });
            }
          } catch {
            /* Unrelated navigation reads receive zero. */
          }
          return `0x${"0".repeat(64)}`;
        }
        return { __error: { code: -32601, message: `Unsupported test RPC ${method}` } };
      };
      await page.exposeFunction("activationTestRpc", rpc);
      await page.addInitScript(() => {
        localStorage.setItem("gnars:view-as", "eoa");
        const provider = {
          isMetaMask: true,
          async request(input: unknown) {
            const result = await (
              window as unknown as { activationTestRpc(input: unknown): Promise<unknown> }
            ).activationTestRpc(input);
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
          uuid: "00000000-0000-4000-8000-000000000003",
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
        const req = route.request();
        const url = new URL(req.url());
        if (req.method() === "POST") {
          let payload: unknown;
          try {
            payload = req.postDataJSON();
          } catch {
            /* Blocked below. */
          }
          const inputs = Array.isArray(payload) ? payload : [payload];
          if (
            inputs.every(
              (input) =>
                input && typeof input === "object" && "jsonrpc" in input && "method" in input,
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
          // No application publication, signature, or external write may escape this test.
          return route.abort("blockedbyclient");
        }
        if (url.pathname === "/api/marketplace/readiness") return route.fulfill({ json: ready });
        if (url.pathname.startsWith("/api/marketplace"))
          return route.fulfill({
            json: {
              ...ready,
              sources: { catalogue: { available: true }, ...ready.sources },
              ownershipVerified: true,
              nextCursor: null,
              items: [
                {
                  tokenId: "42",
                  name: "Gnar #42",
                  image: "/gnars.webp",
                  owner: ACCOUNT,
                  offers: [],
                },
              ],
            },
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
      await page.getByRole("button", { name: "Ver Gnar #42", exact: true }).click();
      const drawer = page.getByRole("dialog");
      await drawer.getByRole("button", { name: "Anunciar", exact: true }).click();
      const destination = drawer.locator("#market-destination");
      await expect(destination).toContainText("Contrato Gnars");
      await expect
        .poll(() =>
          destination
            .locator("img")
            .evaluate(
              (img) =>
                (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0,
            ),
        )
        .toBe(true);
      await destination.click();
      const options = page.getByRole("listbox");
      await expect(options.getByRole("option")).toHaveCount(3);
      await expect(
        options.getByRole("option", { name: "Contrato Gnars", exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      for (const name of ["Contrato Gnars", "OpenSea"]) {
        const logo = options.getByRole("option", { name, exact: true }).locator("img");
        await expect
          .poll(() =>
            logo.evaluate(
              (img) =>
                (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0,
            ),
          )
          .toBe(true);
      }
      const seaportLogo = options
        .getByRole("option", { name: "Seaport", exact: true })
        .locator('[class*="seaport-brand"]');
      await expect(seaportLogo).toBeVisible();
      expect(
        await seaportLogo.evaluate(
          (element) =>
            new Promise<boolean>((resolve) => {
              const url =
                getComputedStyle(element).backgroundImage.match(/url\(["']?(.*?)["']?\)/)?.[1];
              if (!url) return resolve(false);
              const image = new Image();
              image.onload = () => resolve(image.naturalWidth > 0);
              image.onerror = () => resolve(false);
              image.src = url;
            }),
        ),
      ).toBe(true);
      await options.getByRole("option", { name: marketplaceName, exact: true }).click();
      await expect(destination).toContainText(marketplaceName);
      await drawer.getByLabel("Preço (ETH)", { exact: true }).fill("0,01");
      await expect(drawer.getByRole("button", { name: /Revisar e assinar/ })).toBeEnabled();
      await expect(
        drawer.getByText("Taxa do marketplace Gnars (1%)", { exact: true }),
      ).toBeVisible();
      await expect(drawer.getByText("0.0001 ETH", { exact: true })).toBeVisible();
      await expect(drawer.getByText("0.0099 ETH", { exact: true })).toBeVisible();
      await expect(
        drawer.getByRole("link", { name: "Split builders + tesouro", exact: true }),
      ).toHaveAttribute("href", `/pt-br/members/${MARKETPLACE_CONFIG.communityFeeRecipient}`);
      await page.screenshot({
        path: `test-results/marketplace-contract-activation-${marketplaceName}-${approved ? "signature" : "approval"}.png`,
        fullPage: true,
      });
      await drawer.getByRole("button", { name: /Revisar e assinar/ }).click();
      await expect.poll(() => prompts.length, { timeout: 20000 }).toBe(1);
      if (approved) {
        expect(prompts[0].method).toBe("eth_signTypedData_v4");
        const typed = JSON.parse(prompts[0].params![1] as string);
        expect(typed.domain.verifyingContract.toLowerCase()).toBe(protocol.toLowerCase());
        expect(Number(typed.domain.chainId)).toBe(8453);
        expect(typed.message.conduitKey).toBe(zeroHash);
        expect(typed.message.consideration).toHaveLength(2);
        expect(typed.message.consideration[0].recipient.toLowerCase()).toBe(ACCOUNT.toLowerCase());
        expect(typed.message.consideration[0].startAmount).toBe("9900000000000000");
        expect(typed.message.consideration[1].recipient.toLowerCase()).toBe(
          MARKETPLACE_CONFIG.communityFeeRecipient,
        );
        expect(typed.message.consideration[1].startAmount).toBe("100000000000000");
        expect(
          toHex(BigInt(typed.message.salt), { size: 32 }).startsWith(stringToHex(BUILDER_CODE)),
        ).toBe(true);
      } else {
        expect(prompts[0].method).toBe("eth_sendTransaction");
        const tx = prompts[0].params![0] as { to: string; data: `0x${string}` };
        expect(tx.to.toLowerCase()).toBe(DAO_ADDRESSES.token.toLowerCase());
        expect(tx.data.endsWith(BUILDER_CODE_SUFFIX.slice(2))).toBe(true);
        const decoded = decodeFunctionData({ abi: erc721Abi, data: tx.data });
        expect(decoded.functionName).toBe("approve");
        expect(String(decoded.args?.[0]).toLowerCase()).toBe(protocol.toLowerCase());
        expect(decoded.args?.[1]).toBe(42n);
      }
    });
  }
});
