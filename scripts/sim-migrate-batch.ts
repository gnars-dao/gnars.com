/**
 * Fork simulation of the /migrate "swap → deposit" batch against the LIVE
 * UpgraderEth on Base, with NO offchain Permit2 signature:
 *
 *   1. coin.approve(PERMIT2, amount)
 *   2. PERMIT2.approve(coin, UNIVERSAL_ROUTER, amount, expiration)   (onchain, no sig)
 *   3. UNIVERSAL_ROUTER.execute(commands, inputs) — the Zora quote's call with the
 *      PERMIT2_PERMIT command (and its placeholder signature) stripped out
 *   4. UpgraderEth.deposit{value: minOut}(upgradeId, user, 0x0, minOut)
 *   5. UpgraderEth.withdraw(upgradeId, user, 0x0, minOut)  — the user-side exit
 *
 * This is the exact call list a smart account executes as one batch. Run it
 * before trusting the batch path in the UI:
 *
 *   anvil --fork-url https://base-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY --port 8546
 *   pnpm exec tsx scripts/sim-migrate-batch.ts [holder] [amountIn wei]
 */
import { readFileSync } from "node:fs";
import { createTradeCall, setApiKey } from "@zoralabs/coins-sdk";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  http,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { stripPermitFromRouterCall } from "../src/lib/zora-router-call";

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
setApiKey(env.NEXT_PUBLIC_ZORA_API_KEY);

const FORK = process.env.FORK_RPC ?? "http://127.0.0.1:8546";
const GNARS = "0x0cf0c3b75d522290d7d12c74d7f1f0cc47ccb23b" as Address;
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;
const UPGRADER = (process.env.UPGRADER ?? "0x064fd3d95f322909489dc085bb0044a343191ad3") as Address;
const UPGRADE_ID = BigInt(process.env.UPGRADE_ID ?? "0");
const holder = (process.argv[2] ?? "0x8Bf5941d27176242745B716251943Ae4892a3C26") as Address;
const amountIn = BigInt(process.argv[3] ?? (1000n * 10n ** 18n).toString());

const permit2Abi = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address, address, address) view returns (uint160, uint48, uint48)",
]);
const upgraderAbi = parseAbi([
  "function deposit(uint256 upgradeId, address user, address token, uint256 quantity) payable",
  "function withdraw(uint256 upgradeId, address user, address token, uint256 quantity) payable",
  "function getUserDeposit(uint256 upgradeId, address user, address token) view returns (uint256)",
  "function isHalted() view returns (bool)",
]);

const pc = createPublicClient({ chain: base, transport: http(FORK) });
const wc = createWalletClient({ chain: base, transport: http(FORK), account: holder });
const rpc = (method: string, params: unknown[]) => pc.request({ method, params } as never);

/** Sends from the impersonated holder; returns the gas paid so balance deltas can exclude it. */
async function send(label: string, to: Address, data: Hex, value = 0n): Promise<bigint> {
  const hash = await wc.sendTransaction({ to, data, value, gas: 3_000_000n });
  const r = await pc.waitForTransactionReceipt({ hash });
  console.log(`${r.status === "success" ? "ok  " : "FAIL"} ${label} gas=${r.gasUsed}`);
  if (r.status !== "success") throw new Error(`${label} reverted`);
  return r.gasUsed * r.effectiveGasPrice;
}

async function main() {
  await rpc("anvil_impersonateAccount", [holder]);
  await rpc("anvil_setBalance", [holder, "0x1000000000000000000"]);
  const bal = await pc.readContract({
    address: GNARS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [holder],
  });
  console.log(`holder ${holder} has ${formatEther(bal)} $gnars; selling ${formatEther(amountIn)}`);
  if (bal < amountIn) throw new Error("holder balance too low");

  const quote = await createTradeCall({
    sell: { type: "erc20", address: GNARS },
    buy: { type: "eth" },
    amountIn,
    slippage: 0.05,
    sender: holder,
  });
  if (!quote.success) throw new Error("quote failed");
  const router = quote.call.target as Address;
  const stripped = stripPermitFromRouterCall(quote.call.data as Hex);
  console.log(
    `quote out=${formatEther(BigInt(quote.quote.amountOut))} ETH router=${router} commands ${stripped.before} → ${stripped.after}`,
  );
  const minOut = (BigInt(quote.quote.amountOut) * 95n) / 100n;

  await send(
    "1 coin.approve(PERMIT2)",
    GNARS,
    encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PERMIT2, amountIn] }),
  );
  const exp = Math.floor(Date.now() / 1000) + 3600;
  await send(
    "2 PERMIT2.approve(coin, router)",
    PERMIT2,
    encodeFunctionData({
      abi: permit2Abi,
      functionName: "approve",
      args: [GNARS, router, amountIn, exp],
    }),
  );
  const ethBefore = await pc.getBalance({ address: holder });
  const gasPaid = await send(
    "3 router.execute (permit stripped)",
    router,
    stripped.data,
    BigInt(quote.call.value),
  );
  const ethAfter = await pc.getBalance({ address: holder });
  const received = ethAfter - ethBefore + gasPaid - BigInt(quote.call.value);
  console.log(
    `received ${formatEther(received)} ETH (minOut ${formatEther(minOut)}) ${received >= minOut ? "≥ minOut ✓" : "< minOut ✗"}`,
  );
  if (received < minOut) throw new Error("swap output below minOut");

  console.log(
    `upgrader halted=${await pc.readContract({ address: UPGRADER, abi: upgraderAbi, functionName: "isHalted" })}`,
  );
  await send(
    "4 upgrader.deposit{value:minOut}",
    UPGRADER,
    encodeFunctionData({
      abi: upgraderAbi,
      functionName: "deposit",
      args: [UPGRADE_ID, holder, zeroAddress, minOut],
    }),
    minOut,
  );
  const dep = await pc.readContract({
    address: UPGRADER,
    abi: upgraderAbi,
    functionName: "getUserDeposit",
    args: [UPGRADE_ID, holder, zeroAddress],
  });
  console.log(`getUserDeposit = ${formatEther(dep)} ETH ${dep === minOut ? "✓" : "✗"}`);
  await send(
    "5 upgrader.withdraw",
    UPGRADER,
    encodeFunctionData({
      abi: upgraderAbi,
      functionName: "withdraw",
      args: [UPGRADE_ID, holder, zeroAddress, minOut],
    }),
  );
  const dep2 = await pc.readContract({
    address: UPGRADER,
    abi: upgraderAbi,
    functionName: "getUserDeposit",
    args: [UPGRADE_ID, holder, zeroAddress],
  });
  console.log(
    `after withdraw getUserDeposit = ${formatEther(dep2)} ETH ${dep2 === 0n ? "✓" : "✗"}`,
  );
}

main().catch((e) => {
  console.error("SIM FAILED:", e.shortMessage ?? e.message);
  process.exit(1);
});
