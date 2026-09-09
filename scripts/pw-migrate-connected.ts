/**
 * Runtime capture of /migrate's CONNECTED states with a read-only wallet.
 *
 * Injects a minimal EIP-1193 provider that answers `eth_accounts` with the
 * address in IMPERSONATE (default: a real old-$gnars holder) and forwards every
 * read to Base. Any signing request throws, so the page renders the two
 * columns — "What you hold" (ETH row, old-$gnars row, Zora coins list with
 * per-row quotes) and "Your migration deposit" (the receipt, the primary CTA,
 * the deposit terminal, the position block) — with live data, and no
 * transaction can ever be sent. This is the "click around connected" pass that
 * a headless run otherwise cannot do; the money-moving clicks stay on the human
 * checklist (docs/features/migrate-runtime-checklist.md).
 *
 *   pnpm dev -p 3002                                            # terminal live (config defaults)
 *   NEXT_PUBLIC_UPGRADER_ADDRESS= pnpm dev -p 3003              # terminal gated ("Opens at launch")
 *   BASE_URL=http://localhost:3002 OUT=./shots pnpm exec tsx scripts/pw-migrate-connected.ts
 */
import { mkdirSync, readFileSync } from "node:fs";
import { chromium, type Locator, type Page } from "@playwright/test";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3002";
const OUT = process.env.OUT ?? "./shots";
const TAG = process.env.TAG ?? "connected";
const IMPERSONATE = (
  process.env.IMPERSONATE ?? "0x8Bf5941d27176242745B716251943Ae4892a3C26"
).toLowerCase();
const LOCALE = process.env.LOCALE ?? "pt-br";
/** Comma-separated subset of desktop,mobile. */
const VIEWPORTS = (process.env.VIEWPORTS ?? "desktop,mobile").split(",");
const DEBUG = process.env.DEBUG === "1";
/** "sa" | "eoa" — the WalletDrawer toggle, persisted under gnars:view-as. */
const VIEW_MODE = process.env.VIEW_MODE;

function rpcUrl(): string {
  if (process.env.BASE_RPC_URL) return process.env.BASE_RPC_URL;
  const env = Object.fromEntries(
    readFileSync(".env.local", "utf8")
      .split("\n")
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => {
        const i = l.indexOf("=");
        return [
          l.slice(0, i).trim(),
          l
            .slice(i + 1)
            .trim()
            .replace(/^"|"$/g, ""),
        ];
      }),
  );
  return `https://base-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`;
}

/** Browser-side provider. Everything that would sign is refused. */
const providerScript = (address: string, rpc: string) => `
(() => {
  const address = ${JSON.stringify(address)};
  const rpc = ${JSON.stringify(rpc)};
  const listeners = {};
  let id = 1;
  const forward = async (method, params) => {
    const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params: params ?? [] }) });
    const json = await res.json();
    if (json.error) { const e = new Error(json.error.message); e.code = json.error.code; throw e; }
    return json.result;
  };
  const provider = {
    isMetaMask: true,
    _readOnlyImpersonation: address,
    request: async ({ method, params }) => {
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts": return [address];
        case "eth_chainId": return "0x2105";
        case "net_version": return "8453";
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain":
        case "wallet_requestPermissions": return null;
        case "wallet_getPermissions": return [{ parentCapability: "eth_accounts" }];
        case "eth_sendTransaction":
        case "eth_signTransaction":
        case "eth_sign":
        case "personal_sign":
        case "eth_signTypedData":
        case "eth_signTypedData_v3":
        case "eth_signTypedData_v4": {
          const e = new Error("read-only impersonation: signing refused"); e.code = 4001; throw e;
        }
        default: return forward(method, params);
      }
    },
    on: (ev, fn) => { (listeners[ev] ||= []).push(fn); return provider; },
    removeListener: (ev, fn) => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); return provider; },
    emit: (ev, ...args) => { (listeners[ev] || []).forEach((f) => f(...args)); },
  };
  Object.defineProperty(window, "ethereum", { value: provider, configurable: true });
  // EIP-6963 announcement so wallet pickers that rely on it find "MetaMask".
  const info = { uuid: "00000000-0000-4000-8000-000000000001", name: "MetaMask", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>", rdns: "io.metamask" };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
})();
`;

async function shot(page: Page, name: string) {
  const file = `${OUT}/migrate-${LOCALE}-${name}-${TAG}.png`;
  await page.screenshot({ path: file, fullPage: true });
  console.log("shot", file);
}

// ---------------------------------------------------------------------------
// Locators, all derived from messages/{en,pt-br}/migrate.json. The connected
// marker is the holdings-card hint ("3 of 12 selected"), the empty state or the
// load error — never the word "Zora coins" on its own, which also appears in
// the DISCONNECTED connect prompt and would make a failed connect look fine.
// ---------------------------------------------------------------------------
/** migrate.hold.selectedCount / .selectedCountNoRoute, migrate.noCoins, migrate.holdingsError */
const CONNECTED_RE =
  /\d+ of \d+ selected|\d+ de \d+ selecionadas|No migratable|Nenhuma coin|Couldn't load your Zora coins|Não foi possível carregar suas coins da Zora/;
/** Playwright needs the slashes to read this as a regex, not a substring. */
const CONNECTED = `text=/${CONNECTED_RE.source}/`;
/** migrate.selectAll */
const SELECT_ALL_RE = /^\s*(Select all|Selecionar tudo)\s*$/i;
/** migrate.hold.deselectUnroutable(Count) */
const DESELECT_UNROUTABLE_RE = /Deselect( \d+)? unroutable|Desmarcar( \d+)? sem rota/i;
/** migrate.oldGnars.include — the checkbox's aria-label */
const INCLUDE_OLD_GNARS_RE = /Sell my old \$gnars|Vender meu \$gnars antigo/i;
/** migrate.deposit.amountEcho */
const AMOUNT_ECHO_RE = /You will send|Você vai enviar/;
/** The WalletDrawer trigger: a short address (0x8Bf5…3C26) or an ENS name. */
const ACCOUNT_BUTTON_RE = /0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}|\.eth\b/;
/** nav.mobileMenu.toggleLabel */
const BURGER_RE = /Toggle menu|Alternar menu/i;

/** migrate.deposit.{live,opensAtLaunch,…} — the title-row status chip. */
function statusChipState(body: string): string {
  if (/Deposits open|Depósitos abertos/.test(body)) return "live";
  if (/Opens at launch|Abre no lançamento/.test(body)) return "gated";
  if (/Halted by the operator|Pausado pelo operador/.test(body)) return "halted";
  if (/Launched|Lançado/.test(body)) return "executed";
  if (/Misconfigured|Mal configurado/.test(body)) return "misconfigured";
  if (/Read failed|Falha na leitura/.test(body)) return "read-failed";
  if (/Checking…|Verificando…/.test(body)) return "checking";
  return "unknown";
}

async function connect(page: Page) {
  await page
    .getByRole("button", { name: /conectar|connect/i })
    .first()
    .click();
  // thirdweb's modal shows social logins first; external wallets sit behind
  // "Connect a Wallet". thirdweb may also auto-connect an injected wallet the
  // moment it sees one, so every step here is "click if present".
  const connected = page.locator(CONNECTED).first();
  const expand = page.getByRole("button", { name: /connect a wallet/i }).first();
  await Promise.race([connected.waitFor({ timeout: 30_000 }), expand.waitFor({ timeout: 30_000 })]);
  if (await connected.isVisible().catch(() => false)) return;
  await expand.click();
  if (DEBUG) await shot(page, "debug-after-expand");
  const mm = page.getByRole("button", { name: /metamask/i }).first();
  await Promise.race([connected.waitFor({ timeout: 30_000 }), mm.waitFor({ timeout: 30_000 })]);
  if (await connected.isVisible().catch(() => false)) return;
  await mm.click();
  if (DEBUG) {
    await page.waitForTimeout(8000);
    await shot(page, "debug-after-metamask");
  }
  // On connect the app may open a dialog (delegation prompt) that, on mobile,
  // scroll-locks the page and hides the list from the locator. Clear it first.
  await page.waitForTimeout(4000);
  await dismissOverlays(page, "dialog-on-connect");
  await connected.waitFor({ timeout: 90_000 });
}

/** Captures and closes whatever dialog/drawer/sheet is open, so the page is clickable. */
async function dismissOverlays(page: Page, shotName?: string) {
  const overlay = page.locator(
    '[data-slot="dialog-overlay"][data-state="open"], [data-slot="drawer-overlay"][data-state="open"], [data-slot="sheet-overlay"][data-state="open"]',
  );
  for (let i = 0; i < 4 && (await overlay.count()); i++) {
    if (i === 0 && shotName) await shot(page, shotName);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);
  }
}

/**
 * Opens the wallet panel and returns its content locator, or null when the
 * panel cannot be reached from this viewport.
 *
 * The header's ConnectButton is `hidden sm:block`, so at 390px the only
 * WalletDrawer trigger on the page lives in the mobile-nav sheet footer: open
 * the hamburger first, then press the account button inside it. Clicking "the
 * last header button" instead (what this script used to do) lands on the locale
 * switcher or a disabled control and fails the whole mobile run.
 */
async function openWalletPanel(page: Page, vp: string): Promise<Locator | null> {
  const drawerSel = '[data-slot="drawer-content"], [data-slot="dialog-content"], [role="dialog"]';
  const accountIn = (scope: Locator) =>
    scope.getByRole("button").filter({ hasText: ACCOUNT_BUTTON_RE }).first();

  let account = accountIn(page.locator("header"));
  if (!(await account.isVisible().catch(() => false))) {
    const burger = page.getByRole("button", { name: BURGER_RE }).first();
    if (!(await burger.isVisible().catch(() => false))) {
      console.log(vp, "wallet drawer: no account button and no mobile menu — skipped");
      return null;
    }
    await burger.click();
    await page.waitForTimeout(1200);
    account = accountIn(page.locator('[data-slot="sheet-content"]'));
    if (!(await account.isVisible().catch(() => false))) {
      console.log(vp, "wallet drawer: account button not in the mobile menu — skipped");
      await dismissOverlays(page);
      return null;
    }
  }
  await account.click();
  await page.waitForTimeout(1500);
  const drawer = page.locator(drawerSel).last();
  if (!(await drawer.count())) {
    console.log(vp, "wallet drawer: trigger pressed but no panel opened — skipped");
    return null;
  }
  return drawer;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const errors: string[] = [];
  const viewports = (
    [
      ["desktop", 1280, 900],
      ["mobile", 390, 844],
    ] as const
  ).filter(([vp]) => VIEWPORTS.includes(vp));
  for (const [vp, w, h] of viewports) {
    const ctx = await browser.newContext({
      viewport: { width: w, height: h },
      locale: LOCALE === "pt-br" ? "pt-BR" : "en-US",
    });
    await ctx.addInitScript(providerScript(IMPERSONATE, rpcUrl()));
    if (VIEW_MODE) {
      await ctx.addInitScript(
        (mode: string) => window.localStorage.setItem("gnars:view-as", mode),
        VIEW_MODE,
      );
    }
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`${vp}: ${e.message}`));
    page.on("response", (r) => {
      if (r.status() >= 400) errors.push(`${vp} http ${r.status()} ${r.url().slice(0, 120)}`);
    });
    page.on("console", (m) => {
      if (m.type() !== "error" || /favicon|Failed to load resource/i.test(m.text())) return;
      void Promise.all(
        m
          .args()
          .map((a) =>
            a
              .evaluate((v) =>
                String((v && v.message) || (typeof v === "object" ? JSON.stringify(v) : v)),
              )
              .catch(() => "?"),
          ),
      ).then((args) => errors.push(`${vp} console: ${args.join(" ").slice(0, 300)}`));
    });

    await page.goto(`${BASE_URL}/${LOCALE}/migrate`, {
      waitUntil: "networkidle",
      timeout: 120_000,
    });
    await connect(page);
    // Wait for the holdings card (or its empty/error state) to replace the
    // connect card in the "What you hold" column.
    await page.locator(CONNECTED).first().waitFor({ timeout: 90_000 });
    await page.waitForTimeout(2500);
    await dismissOverlays(page, `${vp}-dialog-on-connect`);
    // The wallet drawer names the signing mode and both addresses — proof of
    // whether the smart-account wrap happened and which mode is active. The app
    // clears the stored view mode on connect, so VIEW_MODE=sa is applied here by
    // pressing the drawer's switch button, exactly as a user would.
    let drawer = await openWalletPanel(page, vp);
    if (drawer) {
      const text = (await drawer.innerText().catch(() => "")).replace(/\s+/g, " ");
      console.log(vp, "wallet drawer (before):", text.slice(0, 300));
      // The active row reads "Admin viewing" / "Admin visualizando" only while
      // an external wallet is being viewed as its EOA.
      const viewingEoa = /Admin\s+(viewing|visualizando)/i.test(text);
      const wantsSa = VIEW_MODE === "sa" && viewingEoa;
      const wantsEoa = VIEW_MODE === "eoa" && !viewingEoa;
      if (wantsSa || wantsEoa) {
        const toggle = drawer.getByRole("button", { name: /Mudar para|Switch to/i }).first();
        if (await toggle.count()) {
          await toggle.click();
          await page.waitForTimeout(1500);
          drawer = page
            .locator('[data-slot="drawer-content"], [data-slot="dialog-content"], [role="dialog"]')
            .last();
          console.log(
            vp,
            "wallet drawer (after switch):",
            (await drawer.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 300),
          );
        }
      }
      await shot(page, `${vp}-wallet-drawer`);
      await dismissOverlays(page);
      await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(3000);
    await shot(page, `${vp}-holdings`);

    // Select everything and let the quotes come in. The receipt on the right
    // must move with it: "+ N Zora coins, sold" and "Available to deposit".
    const selectAll = page.getByRole("button", { name: SELECT_ALL_RE });
    if (await selectAll.count()) {
      await selectAll.first().click();
      await page.waitForTimeout(6000);
      await shot(page, `${vp}-preview`);
    }

    // "Deselect N unroutable": one press must drop exactly the no-route and
    // quote-failed rows out of the selection. Disabled means there were none.
    const deselect = page.getByRole("button", { name: DESELECT_UNROUTABLE_RE }).first();
    if (await deselect.count()) {
      const label = (await deselect.innerText().catch(() => "")).replace(/\s+/g, " ");
      if (await deselect.isEnabled().catch(() => false)) {
        await deselect.click();
        await page.waitForTimeout(4000);
        console.log(vp, "deselect unroutable: pressed", JSON.stringify(label));
        await shot(page, `${vp}-after-deselect`);
      } else {
        console.log(vp, "deselect unroutable: disabled (0 unroutable selected) — skipped");
      }
    }

    // Include old $gnars if its row rendered and its quote resolved. The row is
    // opt-in from its own checkbox, whose aria-label is the include copy.
    const includeBox = page.getByRole("checkbox", { name: INCLUDE_OLD_GNARS_RE }).first();
    if (await includeBox.count()) {
      const cardText = await includeBox
        .locator('xpath=ancestor::*[@data-slot="card"][1]')
        .innerText()
        .catch(() => "");
      console.log(vp, "old-gnars row:", cardText.replace(/\s+/g, " ").slice(0, 300));
      for (let i = 0; i < 20 && !(await includeBox.isEnabled().catch(() => false)); i++)
        await page.waitForTimeout(1000);
      if (await includeBox.isEnabled().catch(() => false)) {
        await includeBox.click();
        await page.waitForTimeout(6000);
        await shot(page, `${vp}-with-old-gnars`);
      } else {
        console.log(vp, "old-gnars include stayed disabled (quote missing or errored)");
      }
    }

    await dismissOverlays(page);
    const header = await page
      .locator("header")
      .first()
      .innerText()
      .catch(() => "");
    console.log(vp, "header:", header.replace(/\s+/g, " ").slice(0, 120));
    // The comma-decimal guard: a Brazilian iPhone keyboard offers only ",".
    // Type "0,05" into the deposit field and read back what the page says it
    // will send — it must be 0.05, never 5.
    const amount = page.locator("#migration-eth-amount");
    if (await amount.count()) {
      await amount.fill("0,05");
      await page.waitForTimeout(500);
      const echo = await page
        .locator(`text=/${AMOUNT_ECHO_RE.source}/`)
        .first()
        .locator("xpath=..")
        .innerText()
        .catch(() => "(no echo)");
      console.log(
        vp,
        "typed 0,05 → field:",
        await amount.inputValue(),
        "| echo:",
        echo.replace(/\s+/g, " "),
      );
      await shot(page, `${vp}-comma-amount`);
      await amount.fill("");
    }

    const body = await page.locator("body").innerText();
    console.log(
      vp,
      "status chip:",
      statusChipState(body),
      "| old-gnars row:",
      /Old \$gnars|\$gnars antigo/.test(body),
      "| impact shown:",
      /Price impact|Impacto no preço/.test(body),
      "| hold option:",
      /hold it and do nothing|segure e não faça nada/i.test(body),
      "| no-liquidity rows:",
      /No liquidity|Sem liquidez/.test(body),
      "| quote-failed rows:",
      /Quote failed|Cotação falhou/.test(body),
      "| receipt total:",
      /Available to deposit|Disponível para depositar/.test(body),
      "| mode note:",
      /One signature|Uma assinatura/.test(body)
        ? "batch"
        : /signatures|assinaturas/.test(body)
          ? "sequential"
          : "none",
    );
    await ctx.close();
  }
  await browser.close();
  if (errors.length) {
    console.log("PAGE ERRORS:");
    errors.forEach((e) => console.log("  ", e));
  } else console.log("no page errors");
}

main().catch((e) => {
  console.error("HARNESS FAILED:", e.message);
  process.exit(1);
});
