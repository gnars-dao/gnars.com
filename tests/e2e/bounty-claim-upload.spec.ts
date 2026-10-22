import { expect, test, type Page, type Route } from "@playwright/test";

const owner = "0x1111111111111111111111111111111111111111";
const signedUrl = "https://uploads.pinata.cloud/v3/files/mock-signed";
// 3 MB stand-in for an iPhone clip; content is never decoded.
const video = {
  name: "IMG_7910.MOV",
  mimeType: "video/quicktime",
  buffer: Buffer.alloc(3 * 1024 * 1024),
};

type PinataHandler = (route: Route) => Promise<void>;

async function setup(page: Page) {
  const writes: string[] = [];
  let pinata: PinataHandler = (route) =>
    route.fulfill({ status: 500, body: "no handler configured" });

  async function rpc({ method }: { method: string }): Promise<unknown> {
    if (method === "personal_sign") return `0x${"11".repeat(64)}1b`;
    if (/send|sign/i.test(method)) {
      writes.push(method);
      throw new Error("Transaction signing forbidden in claim upload tests");
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
  await page.exposeFunction("claimUploadRpc", rpc);
  await page.addInitScript(() => {
    localStorage.setItem("gnars:view-as", "eoa");
    localStorage.setItem(
      "gnars:aa-welcome-dismissed:0x1111111111111111111111111111111111111111",
      "true",
    );
    const provider = {
      isMetaMask: true,
      request: (input: unknown) =>
        (window as unknown as { claimUploadRpc(input: unknown): Promise<unknown> }).claimUploadRpc(
          input,
        ),
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
        new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }),
      );
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/pinata/signed-url")
      return route.fulfill({ json: { success: true, data: signedUrl } });
    if (request.url() === signedUrl) return pinata(route);
    if (url.pathname.includes("/api/ens"))
      return route.fulfill({ json: { ens: null, address: null } });
    if (request.method() === "POST") {
      let body;
      try {
        body = request.postDataJSON();
      } catch {
        body = null;
      }
      const inputs = Array.isArray(body) ? body : [body];
      if (inputs.every((input) => input && typeof input === "object" && "method" in input)) {
        const result = await Promise.all(
          inputs.map(async (input) => ({ jsonrpc: "2.0", id: input.id, result: await rpc(input) })),
        );
        return route.fulfill({ json: Array.isArray(body) ? result : result[0] });
      }
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });

  // Open bounty; wait for hydration so the first connect click isn't lost in dev.
  await page.goto("/pt-br/community/bounties/sopa/0", { waitUntil: "networkidle" });
  // Connect from the header first: thirdweb's modal stacked on the claim dialog
  // leaves the page unclickable after it closes.
  await page
    .getByRole("button", { name: /conectar|connect/i })
    .first()
    .click();
  await page.getByRole("button", { name: /connect a wallet/i }).click();
  await page.getByRole("button", { name: /metamask/i }).click();
  await expect(page.getByRole("dialog", { name: "Connect Wallet", exact: true })).not.toBeVisible({
    timeout: 30000,
  });
  await page.getByRole("button", { name: "Enviar prova", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Enviar prova" });
  await expect(dialog.getByRole("button", { name: "Enviar arquivo" })).toBeVisible();
  return {
    dialog,
    writes,
    onPinata: (handler: PinataHandler) => {
      pinata = handler;
    },
  };
}

test.setTimeout(120000);

for (const width of [1440, 390]) {
  test(`claim upload shows progress, can be cancelled, explains failures ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const { dialog, writes, onPinata } = await setup(page);
    const fileInput = dialog.locator('input[type="file"]');
    const shot = (name: string) =>
      page.screenshot({ path: `test-results/claim-upload-${name}-${width}.png` });

    // 1. In-flight upload: progress UI, no way to dismiss by accident, cancel works.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    onPinata(async (route) => {
      await held;
      await route.abort().catch(() => {});
    });
    await fileInput.setInputFiles(video);
    const cancel = dialog.getByRole("button", { name: "Cancelar envio" });
    await expect(cancel).toBeVisible();
    await expect(dialog.getByRole("progressbar", { name: "Progresso do envio" })).toBeVisible();
    await expect(dialog).toContainText(/Preparando envio|Enviando|Finalizando envio/);
    await expect(dialog.getByRole("button", { name: "Close" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Cancelar", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await shot("uploading");
    if (width === 390) {
      const box = await cancel.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await cancel.click();
    release();
    await expect(dialog.getByRole("button", { name: "Enviar arquivo" })).toBeVisible();
    await expect(dialog.locator("p.text-destructive")).toHaveCount(0);

    // 2. Pinata refuses the transfer: message names the step and status.
    onPinata((route) => route.fulfill({ status: 403, body: "expired" }));
    await fileInput.setInputFiles(video);
    await expect(dialog.locator("p.text-destructive")).toContainText(
      "O envio do arquivo foi interrompido (erro 403)",
    );
    await shot("error");

    // 3. Retry without closing the modal succeeds.
    onPinata((route) => route.fulfill({ json: { data: { cid: "bafytestclaim", size: 1 } } }));
    await fileInput.setInputFiles(video);
    await expect(dialog).toContainText("IMG_7910.MOV");
    await expect(dialog.locator("p.text-destructive")).toHaveCount(0);
    await shot("uploaded");

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    ).toBeTruthy();
    const dialogBox = await dialog.boundingBox();
    expect((dialogBox?.y ?? 0) + (dialogBox?.height ?? 0)).toBeLessThanOrEqual(
      (page.viewportSize()?.height ?? 0) + 1,
    );
    expect(writes).toEqual([]);
  });
}
