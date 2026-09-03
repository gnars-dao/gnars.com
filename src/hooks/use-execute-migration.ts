"use client";

/**
 * Gnars Migration — execution: sell Zora coins to ETH, optionally straight into
 * the UpgraderEth deposit.
 *
 * Two modes, picked by what the signing account can do:
 *
 *   batch      — smart account (sponsored gas). ONE signature for the whole run:
 *                per coin [coin.approve(PERMIT2), PERMIT2.approve(coin, router),
 *                router.execute(swap)] and then deposit{value: minOut}. The
 *                router call is Zora's own quote with its PERMIT2_PERMIT command
 *                removed, since the allowance is granted onchain instead of
 *                signed. The deposit is the router's guaranteed minimum from the
 *                SAME calldata that is sent, so it can never exceed what the
 *                swaps deliver. Validated on a Base fork: scripts/sim-migrate-batch.ts.
 *
 *   sequential — plain EOA / Farcaster mini app. The Zora SDK signs a Permit2
 *                permit and sends one swap per coin, then one deposit
 *                transaction. The SDK re-quotes internally, so the deposit is
 *                NOT taken from our quote: it is the ETH the swaps actually
 *                delivered, measured from the signer's balance and the receipts'
 *                gas, capped to leave a gas reserve in the wallet.
 *
 * Every outcome is reported per coin. A partial run is never a green toast, and
 * a deposit that fails after the sales tells the user how much ETH now sits in
 * their wallet and that the terminal below deposits it.
 */
import { useState } from "react";
import { useTranslations } from "next-intl";
import { createTradeCall, setApiKey, tradeCoin, type TradeParameters } from "@zoralabs/coins-sdk";
import { toast } from "sonner";
import { getContract, sendBatchTransaction, sendTransaction, waitForReceipt } from "thirdweb";
import { viemAdapter } from "thirdweb/adapters/viem";
import { base } from "thirdweb/chains";
import {
  formatEther,
  isAddressEqual,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { MIGRATION_SLIPPAGE } from "@/hooks/use-gnars-migration";
import { useUserAddress } from "@/hooks/use-user-address";
import { useWriteAccount } from "@/hooks/use-write-account";
import { prepareContractCall, prepareTransaction } from "@/lib/builder-code";
import {
  isMigrationDepositLive,
  MIGRATION_UPGRADE_ID,
  PERMIT2_ADDRESS,
  UPGRADER_ADDRESS,
} from "@/lib/config";
import { kyberBuildCall, kyberQuoteToEth } from "@/lib/kyber-quote";
import { referenceSlice } from "@/lib/price-impact";
import { expectedFromZoraQuote, routeMarginFromQuotes } from "@/lib/route-margin";
import { getThirdwebClient } from "@/lib/thirdweb";
import { ensureOnChain, normalizeTxError } from "@/lib/thirdweb-tx";
import { depositCall } from "@/lib/upgrader-calls";
import { stripPermitFromRouterCall } from "@/lib/zora-router-call";

if (typeof window !== "undefined") {
  const key = process.env.NEXT_PUBLIC_ZORA_API_KEY;
  if (key) setApiKey(key);
}

export interface CoinToMigrate {
  address: Address;
  symbol: string;
  /** Raw balance (BigInt-safe string). */
  balance: string;
  /** Router the preview quoted this coin on. Defaults to Zora, falls back to Kyber. */
  provider?: "zora" | "kyber";
}

export type StepStatus = "pending" | "active" | "done" | "failed";

export interface MigrationStep {
  label: string;
  status: StepStatus;
}

export type ExecutionMode = "batch" | "sequential";

export interface ExecuteOptions {
  /** Deposit the ETH proceeds into the migration in the same run. */
  depositIntoMigration: boolean;
  slippage?: number;
}

export interface CoinFailure {
  symbol: string;
  /** Human reason from normalizeTxError. */
  reason: string;
  cancelled: boolean;
}

export interface ExecuteResult {
  /** True only when every selected coin sold and (if asked) the deposit landed. */
  ok: boolean;
  mode: ExecutionMode;
  sold: string[];
  failed: CoinFailure[];
  /** ETH (wei) the sells delivered (sequential: measured; batch: guaranteed minimum). */
  received: bigint;
  /** ETH (wei) deposited into the migration, when requested and successful. */
  deposited: bigint;
  /** The sells happened but the deposit did not; `received` is loose in the wallet. */
  depositFailed: boolean;
}

/**
 * ETH left in the wallet after a sequential run so the deposit transaction and
 * a follow-up still have gas. Base gas is cheap; this is generous on purpose.
 */
export const EOA_GAS_RESERVE = 500_000_000_000_000n; // 0.0005 ETH

/**
 * Wallet prompts a sequential run can cost per coin: ERC-20 approve to Permit2
 * (first time), the Permit2 typed-data signature, and the swap.
 */
export const SEQUENTIAL_PROMPTS_PER_COIN = 3;

const ERC20_APPROVE = "function approve(address spender, uint256 amount) returns (bool)" as const;
const PERMIT2_APPROVE =
  "function approve(address token, address spender, uint160 amount, uint48 expiration)" as const;
/** Permit2 allowance lifetime for the batch — long enough to mine, short enough to be harmless. */
const PERMIT2_EXPIRY_SECONDS = 30 * 60;

export function useExecuteMigration() {
  const t = useTranslations("migrate");
  const [isRunning, setIsRunning] = useState(false);
  const [steps, setSteps] = useState<MigrationStep[]>([]);
  const [lastResult, setLastResult] = useState<ExecuteResult | null>(null);
  // Honors the user's view mode: an external wallet in EOA view signs from the
  // EOA (where the funds are); SA view (or an in-app wallet) signs from the SA.
  const writer = useWriteAccount();
  const { address: readAddress } = useUserAddress();

  /** True when the signer can bundle every call into one sponsored userop. */
  const canBatch = Boolean(writer?.account.sendBatchTransaction);

  const execute = async (
    coins: CoinToMigrate[],
    { depositIntoMigration, slippage = MIGRATION_SLIPPAGE }: ExecuteOptions,
  ): Promise<ExecuteResult | undefined> => {
    if (coins.length === 0) return;
    if (!writer) {
      toast.error(t("toasts.connect"));
      return;
    }
    const client = getThirdwebClient();
    if (!client) {
      toast.error(t("toasts.clientMissing"));
      return;
    }
    if (depositIntoMigration && !isMigrationDepositLive()) {
      toast.error(t("toasts.notOpen"));
      return;
    }
    const sender = writer.account.address as Address;
    // The invariant: what the page reads for must be what signs. Refuse here
    // rather than let the Upgrader revert "Not authorized" after the sells.
    if (!readAddress || !isAddressEqual(sender, readAddress as Address)) {
      toast.error(t("toasts.signerMismatch"));
      return;
    }

    const mode: ExecutionMode = writer.account.sendBatchTransaction ? "batch" : "sequential";
    setIsRunning(true);
    setLastResult(null);

    const initial: MigrationStep[] = [
      ...coins.map((c) => ({
        label: `${c.symbol} → ETH${c.provider === "kyber" ? " · Kyber" : ""}`,
        status: "pending" as StepStatus,
      })),
      ...(depositIntoMigration
        ? [{ label: t("steps.deposit"), status: "pending" as StepStatus }]
        : []),
    ];
    setSteps(initial);
    const depositIdx = depositIntoMigration ? coins.length : -1;
    const setStatus = (i: number, status: StepStatus) =>
      setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, status } : s)));
    const setAll = (status: StepStatus, only?: (i: number) => boolean) =>
      setSteps((prev) => prev.map((s, i) => (!only || only(i) ? { ...s, status } : s)));

    const toastId = toast.loading(
      depositIntoMigration ? t("toasts.runDepositLoading") : t("toasts.runSellLoading"),
    );

    let result: ExecuteResult;
    try {
      await ensureOnChain(writer.wallet, base);
      result =
        mode === "batch"
          ? await runBatch({
              coins,
              account: writer.account,
              sender,
              slippage,
              depositIntoMigration,
              setAll,
              setStatus,
            })
          : await runSequential({
              coins,
              writer,
              client,
              sender,
              slippage,
              depositIntoMigration,
              depositIdx,
              setStatus,
            });
    } catch (err) {
      // Nothing was partially done (batch is atomic; sequential reports per coin
      // and only throws before the first sale) — one honest error.
      setAll("failed", (i) => i >= 0);
      const { message, category } = normalizeTxError(err);
      if (category === "user-rejected") toast.info(t("toasts.cancelled"), { id: toastId });
      else toast.error(t("toasts.runFailed"), { id: toastId, description: message });
      setIsRunning(false);
      const failed: ExecuteResult = {
        ok: false,
        mode,
        sold: [],
        failed: coins.map((c) => ({
          symbol: c.symbol,
          reason: message,
          cancelled: category === "user-rejected",
        })),
        received: 0n,
        deposited: 0n,
        depositFailed: false,
      };
      setLastResult(failed);
      return failed;
    }

    setIsRunning(false);
    setLastResult(result);
    const failedSymbols = result.failed.map((f) => f.symbol).join(", ");
    if (result.depositFailed) {
      toast.error(t("toasts.depositAfterSellsFailed", { amount: formatEther(result.received) }), {
        id: toastId,
        duration: 20_000,
      });
    } else if (result.failed.length > 0 && result.sold.length === 0) {
      const allCancelled = result.failed.every((f) => f.cancelled);
      if (allCancelled) toast.info(t("toasts.cancelled"), { id: toastId });
      else toast.error(t("toasts.noneSold"), { id: toastId, description: failedSymbols });
    } else if (result.failed.length > 0) {
      toast.warning(
        t("toasts.partial", {
          sold: result.sold.length,
          total: coins.length,
          failed: failedSymbols,
        }),
        { id: toastId, duration: 20_000 },
      );
    } else {
      toast.success(
        depositIntoMigration ? t("toasts.runDepositSuccess") : t("toasts.runSellSuccess"),
        { id: toastId },
      );
    }
    return result;
  };

  /** Sell the coins and deposit the proceeds — the presale entry, in one run. */
  const swapAndDeposit = (coins: CoinToMigrate[], slippage?: number) =>
    execute(coins, { depositIntoMigration: true, slippage });

  return { execute, swapAndDeposit, isRunning, steps, canBatch, lastResult };
}

type WriterAccount = NonNullable<ReturnType<typeof useWriteAccount>>;

/**
 * Quote a coin to ETH at a slippage derived from its own route: a 1% slice for
 * the marginal price, the full balance for the realised one, then the final
 * quote (whose calldata carries the router's amountOutMin) at that margin.
 * `maxSlippage` caps the margin; the route-margin floor/ceiling apply inside.
 */
async function quoteToEth(coin: CoinToMigrate, sender: Address, maxSlippage: number) {
  const amountIn = BigInt(coin.balance);
  const params = (amount: bigint, slippage: number): TradeParameters => ({
    sell: { type: "erc20", address: coin.address },
    buy: { type: "eth" },
    amountIn: amount,
    slippage,
    sender,
  });
  const ref = referenceSlice(amountIn);
  const [full, small] = await Promise.all([
    createTradeCall(params(amountIn, maxSlippage)),
    ref === amountIn ? null : createTradeCall(params(ref, maxSlippage)).catch(() => null),
  ]);
  if (!full?.success || !full.quote?.amountOut) {
    throw new Error(`No route to ETH for ${coin.symbol}`);
  }
  const fullOut = BigInt(full.quote.amountOut);
  const refOut = small?.success && small.quote?.amountOut ? BigInt(small.quote.amountOut) : 0n;
  const maxBps = Math.round(maxSlippage * 10_000);
  const marginBps = Math.min(maxBps, routeMarginFromQuotes(ref, refOut, amountIn, fullOut));
  const slippage = marginBps / 10_000;
  // Re-quote at the route's margin so the calldata's amountOutMin matches it.
  const quote = marginBps === maxBps ? full : await createTradeCall(params(amountIn, slippage));
  if (!quote?.success || !quote.quote?.amountOut) {
    throw new Error(`No route to ETH for ${coin.symbol}`);
  }
  // Zora's amountOut is already the router's minimum at `slippage` — using it
  // as the deposit floor applies the margin exactly once.
  const minOut = BigInt(quote.quote.amountOut);
  return {
    quote,
    slippage,
    marginBps,
    minOut,
    expected: expectedFromZoraQuote(minOut, slippage),
  };
}

/**
 * One coin's sell leg as plain calls plus the router-enforced minimum. Zora:
 * approve → Permit2 approve → router (permit stripped). Kyber: approve → router.
 * Kyber is tried when the coin was quoted there, or when Zora has no route now.
 */
async function buildSellLeg(
  coin: CoinToMigrate,
  sender: Address,
  slippage: number,
): Promise<{
  calls: { to: Address; data?: Hex; value: bigint; method?: never }[];
  approvals: { token: Address; spender: Address; amount: bigint; permit2?: { router: Address } }[];
  minOut: bigint;
  provider: "zora" | "kyber";
}> {
  const amountIn = BigInt(coin.balance);
  const viaKyber = async () => {
    const k = await kyberQuoteToEth(coin.address, amountIn);
    if (!k) throw new Error(`No route to ETH for ${coin.symbol}`);
    const built = await kyberBuildCall(k, sender, Math.round(slippage * 10_000));
    return {
      calls: [{ to: built.router, data: built.data, value: built.value }],
      approvals: [{ token: coin.address, spender: built.router, amount: amountIn }],
      minOut: built.amountOutMin,
      provider: "kyber" as const,
    };
  };
  if (coin.provider === "kyber") return viaKyber();
  try {
    const { quote, minOut } = await quoteToEth(coin, sender, slippage);
    const router = quote.call.target as Address;
    const stripped = stripPermitFromRouterCall(quote.call.data as Hex);
    return {
      calls: [{ to: router, data: stripped.data, value: BigInt(quote.call.value) }],
      approvals: [
        { token: coin.address, spender: PERMIT2_ADDRESS, amount: amountIn, permit2: { router } },
      ],
      minOut,
      provider: "zora" as const,
    };
  } catch (zoraErr) {
    try {
      return await viaKyber();
    } catch {
      throw zoraErr;
    }
  }
}

async function runBatch({
  coins,
  account,
  sender,
  slippage,
  depositIntoMigration,
  setAll,
  setStatus,
}: {
  coins: CoinToMigrate[];
  account: WriterAccount["account"];
  sender: Address;
  slippage: number;
  depositIntoMigration: boolean;
  setAll: (status: StepStatus, only?: (i: number) => boolean) => void;
  setStatus: (i: number, status: StepStatus) => void;
}): Promise<ExecuteResult> {
  const client = getThirdwebClient()!;
  const expiration = Math.floor(Date.now() / 1000) + PERMIT2_EXPIRY_SECONDS;
  const transactions = [];
  let minOut = 0n;

  // Quoting can fail per coin (dead route, API down, unexpected calldata). Mark
  // that coin's row, not every row, and stop before anything is signed.
  for (let i = 0; i < coins.length; i++) {
    const coin = coins[i];
    setStatus(i, "active");
    let leg;
    try {
      leg = await buildSellLeg(coin, sender, slippage);
    } catch (err) {
      setStatus(i, "failed");
      throw err;
    }
    minOut += leg.minOut;
    for (const a of leg.approvals) {
      transactions.push(
        prepareContractCall({
          contract: getContract({ client, chain: base, address: a.token }),
          method: ERC20_APPROVE,
          params: [a.spender, a.amount],
        }),
      );
      if (a.permit2) {
        transactions.push(
          prepareContractCall({
            contract: getContract({ client, chain: base, address: PERMIT2_ADDRESS }),
            method: PERMIT2_APPROVE,
            params: [a.token, a.permit2.router, a.amount, expiration],
          }),
        );
      }
    }
    for (const c of leg.calls) {
      transactions.push(
        prepareTransaction({ client, chain: base, to: c.to, data: c.data, value: c.value }),
      );
    }
  }

  if (depositIntoMigration) {
    transactions.push(
      prepareContractCall({
        contract: getContract({ client, chain: base, address: UPGRADER_ADDRESS as Address }),
        ...depositCall(MIGRATION_UPGRADE_ID as bigint, sender, minOut),
      }),
    );
  }

  // The account is the smart account: the whole list becomes one userop.
  setAll("active");
  try {
    const result = await sendBatchTransaction({ account, transactions });
    await waitForReceipt({ client, chain: base, transactionHash: result.transactionHash });
  } catch (err) {
    setAll("failed");
    throw err;
  }
  setAll("done");
  return {
    ok: true,
    mode: "batch",
    sold: coins.map((c) => c.symbol),
    failed: [],
    received: minOut,
    deposited: depositIntoMigration ? minOut : 0n,
    depositFailed: false,
  };
}

async function runSequential({
  coins,
  writer,
  client,
  sender,
  slippage,
  depositIntoMigration,
  depositIdx,
  setStatus,
}: {
  coins: CoinToMigrate[];
  writer: WriterAccount;
  client: NonNullable<ReturnType<typeof getThirdwebClient>>;
  sender: Address;
  slippage: number;
  depositIntoMigration: boolean;
  depositIdx: number;
  setStatus: (i: number, status: StepStatus) => void;
}): Promise<ExecuteResult> {
  // viemAdapter clients are typed against thirdweb's bundled viem; cast via
  // unknown so the Zora SDK (project viem types) accepts them.
  const walletClient = viemAdapter.wallet.toViem({
    wallet: writer.wallet,
    chain: base,
    client,
  }) as unknown as WalletClient;
  const publicClient = viemAdapter.publicClient.toViem({
    chain: base,
    client,
  }) as unknown as PublicClient;

  const sold: string[] = [];
  const failed: CoinFailure[] = [];
  let received = 0n;

  for (let i = 0; i < coins.length; i++) {
    setStatus(i, "active");
    try {
      if (coins[i].provider === "kyber") {
        // Kyber: approve the router, then one plain call — measured the same way.
        const leg = await buildSellLeg(coins[i], sender, slippage);
        const before = await publicClient.getBalance({ address: sender });
        let gasPaid = 0n;
        for (const a of leg.approvals) {
          const tx = prepareContractCall({
            contract: getContract({ client, chain: base, address: a.token }),
            method: ERC20_APPROVE,
            params: [a.spender, a.amount],
          });
          const r = await sendTransaction({ account: writer.account, transaction: tx });
          const rc = await waitForReceipt({
            client,
            chain: base,
            transactionHash: r.transactionHash,
          });
          gasPaid += rc.gasUsed * rc.effectiveGasPrice;
        }
        for (const c of leg.calls) {
          const tx = prepareTransaction({
            client,
            chain: base,
            to: c.to,
            data: c.data,
            value: c.value,
          });
          const r = await sendTransaction({ account: writer.account, transaction: tx });
          const rc = await waitForReceipt({
            client,
            chain: base,
            transactionHash: r.transactionHash,
          });
          gasPaid += rc.gasUsed * rc.effectiveGasPrice;
          // A mined-but-reverted swap delivered nothing: a failure, not a ✓.
          if (rc.status !== "success") {
            throw new Error(`Kyber swap reverted (${r.transactionHash})`);
          }
        }
        const after = await publicClient.getBalance({ address: sender });
        const delta = after - before + gasPaid;
        received += delta > 0n ? delta : 0n;
        sold.push(coins[i].symbol);
        setStatus(i, "done");
        continue;
      }
      const routeQuote = await quoteToEth(coins[i], sender, slippage);
      // The SDK re-quotes internally, so what it enforces is not our quote.
      // Measure what actually arrived: balance delta plus the gas the swap
      // (and any approve inside the SDK) cost, which the receipts report.
      const before = await publicClient.getBalance({ address: sender });
      const receipt = (await tradeCoin({
        tradeParameters: {
          sell: { type: "erc20", address: coins[i].address },
          buy: { type: "eth" },
          amountIn: BigInt(coins[i].balance),
          slippage: routeQuote.slippage,
          sender,
        },
        walletClient,
        account: walletClient.account!,
        publicClient,
      })) as { gasUsed?: bigint; effectiveGasPrice?: bigint } | undefined;
      const after = await publicClient.getBalance({ address: sender });
      const swapGas = (receipt?.gasUsed ?? 0n) * (receipt?.effectiveGasPrice ?? 0n);
      // An approve sent inside the SDK also cost gas we cannot see here; the
      // delta is therefore a floor on what was received, never a ceiling.
      const delta = after - before + swapGas;
      received += delta > 0n ? delta : 0n;
      sold.push(coins[i].symbol);
      setStatus(i, "done");
    } catch (err) {
      const { message, category } = normalizeTxError(err);
      console.error(`[migration] swap failed for ${coins[i].symbol}`, err);
      failed.push({
        symbol: coins[i].symbol,
        reason: message,
        cancelled: category === "user-rejected",
      });
      setStatus(i, "failed");
    }
  }

  const base_: Omit<ExecuteResult, "deposited" | "depositFailed" | "ok"> = {
    mode: "sequential",
    sold,
    failed,
    received,
  };
  if (sold.length === 0) {
    return { ...base_, ok: false, deposited: 0n, depositFailed: false };
  }
  if (!depositIntoMigration) {
    return { ...base_, ok: failed.length === 0, deposited: 0n, depositFailed: false };
  }

  // Deposit what the sells delivered, leaving a gas reserve in the wallet.
  setStatus(depositIdx, "active");
  const balance = await publicClient.getBalance({ address: sender });
  const spendable = balance > EOA_GAS_RESERVE ? balance - EOA_GAS_RESERVE : 0n;
  const amount = received < spendable ? received : spendable;
  if (amount <= 0n) {
    setStatus(depositIdx, "failed");
    return { ...base_, ok: false, deposited: 0n, depositFailed: true };
  }
  try {
    const transaction = prepareContractCall({
      contract: getContract({ client, chain: base, address: UPGRADER_ADDRESS as Address }),
      ...depositCall(MIGRATION_UPGRADE_ID as bigint, sender, amount),
    });
    const result = await sendTransaction({ account: writer.account, transaction });
    await waitForReceipt({ client, chain: base, transactionHash: result.transactionHash });
    setStatus(depositIdx, "done");
  } catch (err) {
    console.error("[migration] deposit after sells failed", err);
    setStatus(depositIdx, "failed");
    return { ...base_, ok: false, deposited: 0n, depositFailed: true };
  }
  return { ...base_, ok: failed.length === 0, deposited: amount, depositFailed: false };
}
