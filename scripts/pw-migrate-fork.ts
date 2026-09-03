/**
 * /migrate driven END TO END on an Anvil fork of Base, with a key that signs.
 *
 * This closes the checklist items whose evidence is an on-chain consequence
 * (a sale executing, "Your deposit" rising by the realised amount, a
 * withdrawal returning ETH, a rejected prompt marking one row ✗) without a
 * human and without touching mainnet. Every result it prints is labelled
 * "fork"; nothing here is evidence about production infrastructure.
 *
 * What it does NOT reproduce, on purpose: thirdweb's bundler/paymaster (every
 * smart-account userop runs against the real chain), the in-app wallet's OTP
 * provider, and the Warpcast host. Those stay on the human checklist.
 *
 * Safety: the harness ABORTS unless the RPC is local, answers chainId 8453 and
 * identifies as Anvil. The signing key is generated here and holds only fork
 * funds; it is never a person's credential. The holdings list comes from
 * Zora's indexer, which cannot see the fork, so that one request is redirected
 * to the address whose coins were moved to the test key — balances on the
 * fork are identical to what the list shows.
 *
 *   anvil --fork-url https://base-mainnet.g.alchemy.com/v2/$KEY --port 8546
 *   NEXT_PUBLIC_UPGRADER_ADDRESS=… NEXT_PUBLIC_MIGRATION_UPGRADE_ID=0 \
 *     NEXT_PUBLIC_BASE_RPC_URL=http://127.0.0.1:8546 pnpm dev -p 3002
 *   BASE_URL=http://localhost:3002 OUT=./shots pnpm exec tsx scripts/pw-migrate-fork.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { chromium, type Page, type Route } from "@playwright/test";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  http,
  parseAbi,
  parseEther,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const FORK_RPC = process.env.FORK_RPC ?? "http://127.0.0.1:8546";
/** With no BASE_URL the harness starts its own dev server on DEV_PORT and stops it at the end. */
const DEV_PORT = Number(process.env.DEV_PORT ?? 3077);
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${DEV_PORT}`;
const OUT = process.env.OUT ?? "./shots";
const LOCALE = "pt-br";
/** Whose indexer entry (and fork balances) the test key inherits. */
const DONOR = (process.env.DONOR ?? "0x8Bf5941d27176242745B716251943Ae4892a3C26") as Address;
const UPGRADER = (process.env.UPGRADER ?? "0x064fd3d95f322909489dc085bb0044a343191ad3") as Address;
const UPGRADE_ID = BigInt(process.env.UPGRADE_ID ?? "0");
const GNARS = "0x0cf0c3b75d522290d7d12c74d7f1f0cc47ccb23b" as Address;

const upgraderAbi = parseAbi([
  "function deposit(uint256 upgradeId, address user, address token, uint256 quantity) payable",
  "function getUserDeposit(uint256 upgradeId, address user, address token) view returns (uint256)",
]);

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

const pc = createPublicClient({ chain: base, transport: http(FORK_RPC) });
const rpc = (method: string, params: unknown[] = []) =>
  pc.request({ method, params } as never) as Promise<unknown>;

const results: { item: string; verdict: "pass" | "fail" | "skip"; how: "fork"; note: string }[] =
  [];
function record(item: string, ok: boolean, note: string) {
  results.push({ item, verdict: ok ? "pass" : "fail", how: "fork", note });
  console.log(`${ok ? "PASS" : "FAIL"} [fork] ${item} — ${note}`);
}

/* ---------------------------------------------------------------- guard */
async function assertAnvil() {
  const u = new URL(FORK_RPC);
  if (!["127.0.0.1", "localhost", "::1"].includes(u.hostname)) {
    throw new Error(`REFUSING: FORK_RPC must be local, got ${u.hostname}`);
  }
  const version = String(await rpc("web3_clientVersion"));
  if (!/anvil/i.test(version)) throw new Error(`REFUSING: RPC is not Anvil (${version})`);
  const chainId = Number(await rpc("eth_chainId"));
  if (chainId !== 8453) throw new Error(`REFUSING: fork chainId is ${chainId}, expected 8453`);
  // Anvil-only method: a real node would reject it.
  await rpc("anvil_nodeInfo");
  console.log(`guard ok: ${version} chainId=${chainId} at ${FORK_RPC}`);
}

/** Every run starts from a fresh fork of the current Base head. */
async function resetFork() {
  const upstream =
    process.env.FORK_UPSTREAM ?? `https://base-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`;
  await rpc("anvil_reset", [{ forking: { jsonRpcUrl: upstream } }]);
  console.log(`fork reset to Base head block ${await pc.getBlockNumber()}`);
}

/* -------------------------------------------------------------- prepare */
async function impersonatedSend(from: Address, to: Address, data: Hex, value = 0n) {
  await rpc("anvil_impersonateAccount", [from]);
  const wc = createWalletClient({ chain: base, transport: http(FORK_RPC), account: from });
  const hash = await wc.sendTransaction({ to, data, value, gas: 500_000n });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`prepare tx reverted: ${to} ${data.slice(0, 10)}`);
}

async function prepareTestKey() {
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  await rpc("anvil_setBalance", [account.address, "0x4563918244F40000"]); // 5 ETH
  await rpc("anvil_setBalance", [DONOR, "0x4563918244F40000"]);
  // Move EVERY coin the donor's indexer entry lists, so the redirected list
  // and the fork balances agree exactly. Read the list the way the app does.
  const { getProfileBalances, setApiKey } = await import("@zoralabs/coins-sdk");
  setApiKey(env.NEXT_PUBLIC_ZORA_API_KEY);
  const resp = await getProfileBalances({
    identifier: DONOR.toLowerCase(),
    count: 100,
    chainIds: [8453],
    excludeHidden: true,
    sortOption: "USD_VALUE",
  });
  const moved: string[] = [];
  for (const e of resp.data?.profile?.coinBalances?.edges ?? []) {
    const c = e?.node?.coin;
    if (!c?.address) continue;
    const bal = await pc.readContract({
      address: c.address as Address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [DONOR],
    });
    if (bal === 0n) continue;
    await impersonatedSend(
      DONOR,
      c.address as Address,
      encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [account.address, bal] }),
    );
    moved.push(`${c.symbol}=${formatEther(bal)}`);
  }
  console.log(`test key ${account.address} funded on fork: 5 ETH, ${moved.join(", ")}`);
  return { pk, account };
}

/* ------------------------------------------------------- page plumbing */
async function routeThirdwebRpcToFork(page: Page) {
  const forward = async (route: Route) => {
    const body = route.request().postData() ?? "";
    const res = await fetch(FORK_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    await route.fulfill({ status: 200, contentType: "application/json", body: await res.text() });
  };
  await page.route(/https:\/\/[0-9]+\.rpc\.thirdweb\.com\/.*/, forward);
}

/** Zora's indexer cannot see the fork: serve the donor's list for the test key. */
async function redirectIndexerToDonor(page: Page, testAddress: Address) {
  await page.route(/api-sdk\.zora\.engineering\/profileBalances.*/, async (route) => {
    const url = new URL(route.request().url());
    console.log("  indexer request:", url.searchParams.get("identifier"), "→ donor");
    if (url.searchParams.get("identifier")?.toLowerCase() === testAddress.toLowerCase()) {
      url.searchParams.set("identifier", DONOR.toLowerCase());
    }
    // Zora rate-limits repeated runs; a 429 here would read as "no coins".
    let res: Response | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      res = await fetch(url.toString(), { headers: route.request().headers() });
      if (res.status < 429) break;
      await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
    }
    const text = await res!.text();
    const edges = (text.match(/"node"/g) ?? []).length;
    console.log(`  indexer response: ${res!.status}, ~${edges} coins`);
    await route.fulfill({ status: res!.status, contentType: "application/json", body: text });
  });
}

/** The injected wallet: reads go to the fork; signatures come from the harness key in Node. */
const providerScript = (address: string, rpcUrl: string) => `
(() => {
  const address = ${JSON.stringify(address)};
  const rpc = ${JSON.stringify(rpcUrl)};
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
    _forkHarness: true,
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
        case "personal_sign":
        case "eth_sign":
        case "eth_signTypedData":
        case "eth_signTypedData_v3":
        case "eth_signTypedData_v4": {
          const r = await window.__forkSign(method, params);
          if (r && r.__reject) { const e = new Error("User rejected the request."); e.code = 4001; throw e; }
          return r;
        }
        default: return forward(method, params);
      }
    },
    on: (ev, fn) => { (listeners[ev] ||= []).push(fn); return provider; },
    removeListener: (ev, fn) => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); return provider; },
  };
  Object.defineProperty(window, "ethereum", { value: provider, configurable: true });
  const info = { uuid: "00000000-0000-4000-8000-00000000f0f0", name: "MetaMask", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>", rdns: "io.metamask" };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
})();
`;

/** Coerce typed-data numeric strings into bigints for viem. */
function coerceTypedData(td: {
  types: Record<string, { name: string; type: string }[]>;
  message: Record<string, unknown>;
  primaryType: string;
}) {
  const walk = (typeName: string, value: unknown): unknown => {
    const fields = td.types[typeName];
    if (!fields || typeof value !== "object" || value === null) return value;
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const v = (value as Record<string, unknown>)[f.name];
      if (/^u?int\d*$/.test(f.type) && typeof v === "string") out[f.name] = BigInt(v);
      else if (td.types[f.type]) out[f.name] = walk(f.type, v);
      else out[f.name] = v;
    }
    return out;
  };
  return { ...td, message: walk(td.primaryType, td.message) as Record<string, unknown> };
}

type Signer = ReturnType<typeof privateKeyToAccount>;

/** Node-side signing for the injected provider, with an optional scripted rejection. */
function makeForkSigner(account: Signer, plan: { rejectTypedDataAt: number | null }) {
  const wc = createWalletClient({ chain: base, transport: http(FORK_RPC), account });
  let typedDataCount = 0;
  return async (method: string, params: unknown[]) => {
    if (method === "eth_sendTransaction") {
      const tx = params[0] as { to: Address; data?: Hex; value?: Hex; gas?: Hex };
      console.log(
        `  wallet tx → ${tx.to} sel=${(tx.data ?? "0x").slice(0, 10)} value=${tx.value ?? "0x0"} gas=${tx.gas ?? "(estimate)"}`,
      );
      try {
        const hash = await wc.sendTransaction({
          to: tx.to,
          data: tx.data,
          value: tx.value ? BigInt(tx.value) : 0n,
          gas: tx.gas ? BigInt(tx.gas) : undefined,
        });
        void pc
          .waitForTransactionReceipt({ hash })
          .then((rc) =>
            console.log(`  receipt ${hash.slice(0, 10)}… ${rc.status} gasUsed=${rc.gasUsed}`),
          )
          .catch(() => {});
        return hash;
      } catch (e) {
        console.log("  wallet tx FAILED:", (e as Error).message.split("\n")[0].slice(0, 200));
        throw e;
      }
    }
    if (method.startsWith("eth_signTypedData")) {
      typedDataCount += 1;
      if (plan.rejectTypedDataAt === typedDataCount) return { __reject: true };
      const raw = params[1] ?? params[0];
      const td = typeof raw === "string" ? JSON.parse(raw) : raw;
      const { domain, types, primaryType, message } = coerceTypedData(td);
      const { EIP712Domain: _omit, ...rest } = types as Record<string, unknown>;
      void _omit;
      return account.signTypedData({ domain, types: rest as never, primaryType, message } as never);
    }
    if (method === "personal_sign" || method === "eth_sign") {
      const msg = String(params[0]);
      return account.signMessage({ message: msg.startsWith("0x") ? { raw: msg as Hex } : msg });
    }
    throw new Error(`unsupported signing method ${method}`);
  };
}

/* ------------------------------------------------------------ helpers */
async function shot(page: Page, name: string) {
  const file = `${OUT}/fork-${name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  return file;
}
async function dismissOverlays(page: Page) {
  const overlay = page.locator(
    '[data-slot="dialog-overlay"][data-state="open"], [data-slot="drawer-overlay"][data-state="open"]',
  );
  for (let i = 0; i < 3 && (await overlay.count()); i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
  }
}
async function connect(page: Page) {
  await page.goto(`${BASE_URL}/${LOCALE}/migrate`, { waitUntil: "networkidle", timeout: 120_000 });
  await page
    .getByRole("button", { name: /conectar|connect/i })
    .first()
    .click();
  const connected = page
    .locator("text=/coins da Zora \\(|Nenhuma coin|Não foi possível carregar/")
    .first();
  const expand = page.getByRole("button", { name: /connect a wallet/i }).first();
  await Promise.race([connected.waitFor({ timeout: 30_000 }), expand.waitFor({ timeout: 30_000 })]);
  if (!(await connected.isVisible().catch(() => false))) {
    await expand.click();
    const mm = page.getByRole("button", { name: /metamask/i }).first();
    await Promise.race([connected.waitFor({ timeout: 30_000 }), mm.waitFor({ timeout: 30_000 })]);
    if (!(await connected.isVisible().catch(() => false))) await mm.click();
  }
  await page.waitForTimeout(4000);
  await dismissOverlays(page);
  await connected.waitFor({ timeout: 90_000 });
  await page.waitForTimeout(2000);
  await dismissOverlays(page);
  await shot(page, "after-connect");
  console.log("  after connect:", (await connected.innerText()).slice(0, 80));
}

/**
 * The old-$gnars checkbox is enabled only once its quote resolved. Zora
 * rate-limits repeated runs, so wait, and if it never enables, reload (which
 * re-queries) — up to three times before giving up.
 */
async function tickOldGnars(page: Page): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const box = page
      .locator("label", { hasText: /\$gnars antigo/i })
      .locator('[role="checkbox"]')
      .first();
    for (let i = 0; i < 30 && !(await box.isEnabled().catch(() => false)); i++) {
      await page.waitForTimeout(1000);
    }
    if (await box.isEnabled().catch(() => false)) {
      await box.click();
      return true;
    }
    console.log("  old-$gnars quote not available (rate limit?) — reloading");
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(8000);
    await dismissOverlays(page);
  }
  return false;
}

const eth = (s: string) => Number(s.replace(/\./g, "").replace(",", "."));
async function readDeposit(page: Page): Promise<number> {
  const tile = page.locator("text=/Seu depósito|Your deposit/").first().locator("xpath=..");
  const txt = (await tile.innerText()).replace(/\s+/g, " ");
  const m = txt.match(/([\d.,]+) ETH/);
  if (!m) throw new Error(`could not read deposit from "${txt}"`);
  return eth(m[1]);
}
async function waitStepsSettled(page: Page, timeoutMs = 240_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const running = await page.getByRole("button", { name: /Processando|Working/ }).count();
    if (running === 0 && (await page.locator("ol li").count()) > 0) {
      await page.waitForTimeout(1500);
      return;
    }
    await page.waitForTimeout(1500);
  }
  throw new Error("run did not settle");
}
async function stepStatuses(page: Page) {
  // The step list rows all read "X → Y"; the how-it-works list does not.
  const rows = page.locator("ol li").filter({ hasText: "→" });
  const n = await rows.count();
  const out: { label: string; done: boolean; failed: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    out.push({
      label: (await row.innerText()).trim(),
      done: (await row.locator("svg.text-primary").count()) > 0,
      failed: (await row.locator("svg.text-destructive").count()) > 0,
    });
  }
  return out;
}
async function chainDeposit(user: Address) {
  return pc.readContract({
    address: UPGRADER,
    abi: upgraderAbi,
    functionName: "getUserDeposit",
    args: [UPGRADE_ID, user, zeroAddress],
  });
}

/* ------------------------------------------------------------ dev server */
async function waitForServer(url: string, timeoutMs = 180_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`dev server did not answer at ${url}`);
}

/** The terminal envs point at the CURRENT deployment and the fork; nothing here reaches production. */
function startDevServer(): ChildProcess {
  const child = spawn("pnpm", ["dev", "-p", String(DEV_PORT)], {
    env: {
      ...process.env,
      NEXT_PUBLIC_UPGRADER_ADDRESS: UPGRADER,
      NEXT_PUBLIC_MIGRATION_UPGRADE_ID: UPGRADE_ID.toString(),
      NEXT_PUBLIC_BASE_RPC_URL: FORK_RPC,
    },
    stdio: ["pipe", "pipe", "pipe"], // keep stdin open: Next's dev exits on EOF
    // Own process group: Next treats a group-wide SIGHUP/SIGTERM from a parent
    // shell as a graceful shutdown (it printed its cursor-restore and exited 0
    // mid-run, repeatedly). Detached, only stopDev() below can end it.
    detached: true,
  });
  const log = createWriteStream(`${OUT}/dev-server.log`);
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  child.on("exit", (code, signal) =>
    console.log(`  dev server exited code=${code} signal=${signal}`),
  );
  return child;
}

/* ---------------------------------------------------------------- main */
async function main() {
  mkdirSync(OUT, { recursive: true });
  await assertAnvil();
  let dev: ChildProcess | undefined;
  if (!process.env.BASE_URL) {
    dev = startDevServer();
    await waitForServer(`${BASE_URL}/${LOCALE}/migrate`);
    console.log(`dev server up at ${BASE_URL} (fork-backed, terminal on)`);
  }
  const stopDev = () => {
    if (dev?.pid && !dev.killed) {
      try {
        process.kill(-dev.pid, "SIGTERM"); // the whole detached group
      } catch {
        dev.kill("SIGTERM");
      }
    }
  };
  process.on("exit", stopDev);
  const browser = await chromium.launch();

  // Every scenario starts from a fresh fork and a fresh, freshly funded key,
  // so no scenario depends on what an earlier one sold or deposited.
  let scenarios = 0;
  const scenario = async (viewport: { width: number; height: number }) => {
    // Let Zora's rate limit breathe between scenarios.
    if (scenarios++ > 0) await new Promise((r) => setTimeout(r, 20_000));
    await resetFork();
    const { account } = await prepareTestKey();
    const plan = { rejectTypedDataAt: null as number | null };
    const ctx = await browser.newContext({ viewport, locale: "pt-BR" });
    await ctx.addInitScript(providerScript(account.address, FORK_RPC));
    const page = await ctx.newPage();
    await page.exposeFunction("__forkSign", makeForkSigner(account, plan));
    await routeThirdwebRpcToFork(page);
    await redirectIndexerToDonor(page, account.address);
    page.on("pageerror", (e) => console.log("  pageerror:", e.message.slice(0, 160)));
    page.on("console", (m) => {
      if (m.type() === "error" && /\[migration\]/.test(m.text())) {
        void Promise.all(
          m.args().map((a) => a.evaluate((v) => String((v && v.message) || v)).catch(() => "?")),
        ).then((args) => console.log("  app:", args.join(" ").slice(0, 300)));
      }
    });
    return { ctx, page, account, plan };
  };

  // ---- B11: sequential run with the SECOND permit rejected ----------------
  {
    const { ctx, page, account, plan } = await scenario({ width: 1280, height: 900 });
    await connect(page);
    // Select the routable list coin(s) and old $gnars; reject the permit for the 2nd sale.
    await page.getByRole("button", { name: /selecionar tudo/i }).click();
    await page.waitForTimeout(8000);
    await tickOldGnars(page);
    await page.waitForTimeout(6000);
    const preview = await page.locator("body").innerText();
    const promptNote = preview.match(/pedir até (\d+) assinaturas/)?.[1];
    record(
      "B9 sequential signature note",
      Boolean(promptNote),
      `note shows "até ${promptNote} assinaturas"`,
    );
    const before = await chainDeposit(account.address);
    // The first Permit2 signature belongs to the first Zora-routed coin: refuse
    // it. Kyber-routed coins sign no typed data and are unaffected.
    plan.rejectTypedDataAt = 1;
    await page.getByRole("button", { name: /Vender \d+ coins e depositar/ }).click();
    await waitStepsSettled(page);
    const steps = await stepStatuses(page);
    const after = await chainDeposit(account.address);
    const failedRows = steps.filter((s) => s.failed);
    const doneRows = steps.filter((s) => s.done);
    await shot(page, "B11-reject-second-prompt");
    record(
      "B11 reject a signature prompt: that row ✗, rest continue, deposit still happens",
      failedRows.length === 1 && doneRows.length >= 2 && after > before,
      `rows: ${steps.map((s) => `${s.label}${s.done ? " ✓" : s.failed ? " ✗" : ""}`).join(" | ")}; deposit ${formatEther(before)} → ${formatEther(after)} ETH`,
    );
    const stillChecked = await page.locator('[role="checkbox"][data-state="checked"]').count();
    record(
      "B11 failed coin stays selected",
      stillChecked >= 1,
      `${stillChecked} checkbox(es) still checked after the run`,
    );
    plan.rejectTypedDataAt = null;
    await ctx.close();
  }

  // ---- B10: sequential sell + deposit of what is left (old $gnars) --------
  {
    const { ctx, page, account, plan } = await scenario({ width: 1280, height: 900 });
    await connect(page);
    if (!(await tickOldGnars(page))) {
      // Fall back to the list coins if the card's quote never came.
      await page.getByRole("button", { name: /selecionar tudo/i }).click();
    }
    await page.waitForTimeout(6000);
    const est = (await page.locator("body").innerText()).match(
      /VOCÊ RECEBE \(ESTIMADO\)\s*([\d.,]+) ETH/i,
    )?.[1];
    const ethBefore = await pc.getBalance({ address: account.address });
    const depBefore = await chainDeposit(account.address);
    await page.getByRole("button", { name: /Vender \d+ coins e depositar/ }).click();
    await waitStepsSettled(page);
    const steps = await stepStatuses(page);
    const depAfter = await chainDeposit(account.address);
    const ethAfter = await pc.getBalance({ address: account.address });
    const uiDeposit = await readDeposit(page).catch(() => NaN);
    await shot(page, "B10-sell-and-deposit");
    const deposited = depAfter - depBefore;
    record(
      "B10 sequential sell + deposit: steps ✓, deposit = realised ETH",
      steps.every((s) => s.done) &&
        deposited > 0n &&
        Math.abs(uiDeposit - Number(formatEther(depAfter))) < 1e-6,
      `est ${est} ETH; deposited ${formatEther(deposited)} ETH; UI "Seu depósito" ${uiDeposit}; wallet ETH ${formatEther(ethBefore)} → ${formatEther(ethAfter)} (gas reserve kept)`,
    );
    // ---- A7 direct deposit with a comma amount ----------------------------
    const amount = page.locator("#migration-eth-amount");
    await amount.fill("0,01");
    const echo = await page
      .locator("text=/Você vai enviar/")
      .first()
      .locator("xpath=..")
      .innerText();
    const d1 = await chainDeposit(account.address);
    await page.getByRole("button", { name: /^Depositar$/ }).click();
    await page.waitForTimeout(8000);
    const d2 = await chainDeposit(account.address);
    record(
      "A7 + E17 direct deposit typed as 0,01",
      d2 - d1 === parseEther("0.01"),
      `echo "${echo.replace(/\s+/g, " ")}"; deposit +${formatEther(d2 - d1)} ETH`,
    );
    // ---- A6 withdraw everything -------------------------------------------
    await page.getByRole("button", { name: /Sacar tudo/ }).click();
    const w0 = await pc.getBalance({ address: account.address });
    await page.getByRole("button", { name: /^Sacar$/ }).click();
    await page.waitForTimeout(8000);
    const d3 = await chainDeposit(account.address);
    const w1 = await pc.getBalance({ address: account.address });
    const uiAfter = await readDeposit(page).catch(() => NaN);
    await shot(page, "A6-withdraw-all");
    record(
      "A6 withdraw returns the ETH and zeroes the deposit",
      d3 === 0n && w1 > w0 && uiAfter === 0,
      `deposit ${formatEther(d2)} → ${formatEther(d3)} ETH; wallet +${formatEther(w1 - w0)} ETH; UI ${uiAfter}`,
    );
    // ---- A8 reload clears selection --------------------------------------
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(3000);
    await dismissOverlays(page);
    const checked = await page.locator('[role="checkbox"][data-state="checked"]').count();
    record(
      "A8 reload remembers nothing as selected",
      checked === 0,
      `${checked} checked after reload`,
    );
    await ctx.close();
  }

  // ---- Kyber fallback: Zora's quote endpoint down → coins route via Kyber ----
  {
    const { ctx, page, account } = await scenario({ width: 1280, height: 900 });
    await page.route(/api-sdk\.zora\.engineering\/quote.*/, (r) => r.abort());
    await connect(page);
    await page.getByRole("button", { name: /selecionar tudo/i }).click();
    await page.waitForTimeout(12_000);
    const preview = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    const viaKyber = preview.match(/(\d+) dessas coins a Zora não conseguiu rotear/)?.[1];
    record(
      "Kyber fallback quoted when Zora is down",
      Boolean(viaKyber),
      viaKyber ? `preview says ${viaKyber} coin(s) via Kyber` : "no Kyber note in preview",
    );
    const depBefore = await chainDeposit(account.address);
    await page.getByRole("button", { name: /Vender \d+ coins e depositar/ }).click();
    await waitStepsSettled(page);
    const steps = await stepStatuses(page);
    const depAfter = await chainDeposit(account.address);
    await shot(page, "kyber-fallback-sell-and-deposit");
    record(
      "Kyber fallback executes: approve + router call per coin, then deposit",
      steps.some((st) => /Kyber/.test(st.label) && st.done) && depAfter > depBefore,
      `rows: ${steps.map((st) => `${st.label}${st.done ? " ✓" : st.failed ? " ✗" : ""}`).join(" | ")}; deposit +${formatEther(depAfter - depBefore)} ETH`,
    );
    await ctx.close();
  }

  // ---- C13: a deposit under the OTHER address (the SA) → notice in EOA view
  {
    // thirdweb predicts the SA for our key deterministically; fetch it from the
    // page (the header shows it in SA mode) by switching, then switch back.
    const { ctx, page, account, plan } = await scenario({ width: 1280, height: 900 });
    await connect(page);
    await page.locator("header button").last().click();
    await page.waitForTimeout(1500);
    const drawerSel = '[data-slot="drawer-content"], [role="dialog"]';
    const toggle = page
      .locator(drawerSel)
      .last()
      .getByRole("button", { name: /Mudar para wallet/i })
      .first();
    await toggle.click();
    await page.waitForTimeout(1500);
    await dismissOverlays(page);
    await page.waitForTimeout(2000);
    // The drawer's "Perfil" navigates to /members/<full address> of the
    // active (SA) account — the only place the full address is exposed.
    await page.locator("header button").last().click();
    await page.waitForTimeout(1500);
    await page
      .locator(drawerSel)
      .last()
      .getByRole("button", { name: /Perfil|Profile/i })
      .first()
      .click();
    await page.waitForURL(/\/members\/0x[0-9a-fA-F]{40}/, { timeout: 30_000 });
    const full = page.url().match(/0x[0-9a-fA-F]{40}/)?.[0] as Address | undefined;
    await page.goto(`${BASE_URL}/${LOCALE}/migrate`, {
      waitUntil: "networkidle",
      timeout: 120_000,
    });
    await page.waitForTimeout(6000);
    await dismissOverlays(page);
    const headerAddr = full ? `${full.slice(0, 6)}…${full.slice(-4)}` : "?";
    record(
      "C12 SA view: empty list names the admin address",
      /Suas coins estão no seu endereço admin|endereço admin/i.test(
        await page.locator("body").innerText(),
      ),
      `SA ${headerAddr}${full ? "" : " (not found)"}`,
    );
    if (full) {
      await rpc("anvil_setBalance", [full, "0x8AC7230489E80000"]);
      await impersonatedSend(
        full,
        UPGRADER,
        encodeFunctionData({
          abi: upgraderAbi,
          functionName: "deposit",
          args: [UPGRADE_ID, full, zeroAddress, parseEther("0.005")],
        }),
        parseEther("0.005"),
      );
      // back to EOA view: the app reads the persisted choice on mount, so set
      // it and reload — deterministic, unlike a click on an animating drawer.
      await page.evaluate(() => window.localStorage.setItem("gnars:view-as", "eoa"));
      await page.goto(`${BASE_URL}/${LOCALE}/migrate`, { waitUntil: "load", timeout: 120_000 });
      await page.waitForTimeout(10_000);
      await dismissOverlays(page);
      const header = await page.locator("header").innerText();
      console.log("  after switch-back, header:", header.replace(/\s+/g, " ").slice(-30));
      const body = await page.locator("body").innerText();
      const notice = body.match(
        /Você tem ([\d.,]+) ETH depositados pelo seu outro endereço \((0x[^)]+)\)/,
      );
      await shot(page, "C13-other-address-notice");
      record(
        "C13 deposit made as the SA shows as the other-address notice in EOA view",
        Boolean(notice) && eth(notice![1]) === 0.005,
        notice ? notice[0] : "notice not found",
      );
    }
    await ctx.close();
  }

  // ---- F18: RPC unreachable → Read failed, never 0 --------------------------
  {
    const { ctx, page, account, plan } = await scenario({ width: 1280, height: 900 });
    await connect(page);
    await page.route(/127\.0\.0\.1:8546|localhost:8546/, (r) => r.abort());
    await page.unroute(/https:\/\/[0-9]+\.rpc\.thirdweb\.com\/.*/);
    await page.route(/https:\/\/[0-9]+\.rpc\.thirdweb\.com\/.*/, (r) => r.abort());
    await page
      .locator("text=/Tentar de novo/")
      .first()
      .click()
      .catch(() => {});
    await page.waitForTimeout(6000);
    const body = await page.locator("body").innerText();
    await shot(page, "F18-read-failed");
    record(
      "F18 RPC down: badge 'Falha na leitura', no '0 ETH' as fact",
      /Falha na leitura/.test(body) && !/SEU DEPÓSITO\s*0 ETH/i.test(body),
      /Falha na leitura/.test(body) ? "badge present" : "badge missing",
    );
    await ctx.close();
  }

  // ---- E16 mobile: labels + no overflow (with a signing key, same page) ----
  {
    const { ctx, page, account, plan } = await scenario({ width: 390, height: 844 });
    await connect(page);
    const tabs = await page.locator('[role="tab"]').allInnerTexts();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    await shot(page, "E16-mobile");
    record(
      "E16 mobile: tab labels visible, no horizontal scroll",
      tabs.join(",").includes("Entrar") && !overflow,
      `tabs ${JSON.stringify(tabs)}, overflow=${overflow}`,
    );
    const body = await page.locator("body").innerText();
    const english = body.match(/\b(Your deposit|Withdraw|Deposit into|Sell \d+ coins)\b/);
    record(
      "F20 PT-BR: no English leaking in the migrate flow",
      !english && !/tesouraria/i.test(body),
      english ? `found "${english[0]}"` : "clean",
    );
    await ctx.close();
  }

  await browser.close();
  stopDev();
  console.log("\n== SUMMARY (every line is FORK evidence, not production) ==");
  for (const r of results)
    console.log(`${r.verdict.toUpperCase().padEnd(4)} [${r.how}] ${r.item} — ${r.note}`);
  const fails = results.filter((r) => r.verdict === "fail").length;
  console.log(`\n${results.length - fails}/${results.length} passed on the fork; ${fails} failed`);
  if (fails) process.exit(1);
}

main().catch((e) => {
  console.error("FORK HARNESS FAILED:", e.message);
  process.exit(1);
});
