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
 *                signed. Validated on a Base fork: scripts/sim-migrate-batch.ts.
 *
 *   sequential — plain EOA. One wallet prompt per coin (the Zora SDK signs a
 *                Permit2 permit and sends the swap), then one more for the
 *                deposit. Same outcome, more clicks. The UI is told which mode
 *                ran so nobody mistakes the fallback for the batch.
 *
 * The deposit amount is the router's guaranteed minimum, because the exact ETH
 * received is not known inside a batch. The minimum is per route: each coin's
 * slippage is a margin derived from its measured price impact (a 1% slice vs the
 * full balance — src/lib/route-margin.ts), so a deep route leaves ~0.5% in the
 * wallet and a shallow one up to 5%. Whatever arrives above the minimum stays in
 * the wallet as ETH and can be deposited from the terminal.
 */
import { useState } from "react";
import { createTradeCall, setApiKey, tradeCoin, type TradeParameters } from "@zoralabs/coins-sdk";
import { toast } from "sonner";
import { getContract, sendBatchTransaction, sendTransaction, waitForReceipt } from "thirdweb";
import { viemAdapter } from "thirdweb/adapters/viem";
import { base } from "thirdweb/chains";
import { type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { MIGRATION_SLIPPAGE } from "@/hooks/use-gnars-migration";
import { useWriteAccount } from "@/hooks/use-write-account";
import { prepareContractCall, prepareTransaction } from "@/lib/builder-code";
import {
  isMigrationDepositLive,
  MIGRATION_UPGRADE_ID,
  PERMIT2_ADDRESS,
  UPGRADER_ADDRESS,
} from "@/lib/config";
import { referenceSlice } from "@/lib/price-impact";
import { minOutAtMargin, routeMarginFromQuotes } from "@/lib/route-margin";
import { getThirdwebClient } from "@/lib/thirdweb";
import { normalizeTxError } from "@/lib/thirdweb-tx";
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

export interface ExecuteResult {
  ok: boolean;
  mode: ExecutionMode;
  /** ETH (wei) deposited into the migration, when requested. */
  deposited: bigint;
}

const ERC20_APPROVE = "function approve(address spender, uint256 amount) returns (bool)" as const;
const PERMIT2_APPROVE =
  "function approve(address token, address spender, uint160 amount, uint48 expiration)" as const;
/** Permit2 allowance lifetime for the batch — long enough to mine, short enough to be harmless. */
const PERMIT2_EXPIRY_SECONDS = 30 * 60;

export function useExecuteMigration() {
  const [isRunning, setIsRunning] = useState(false);
  const [steps, setSteps] = useState<MigrationStep[]>([]);
  const [lastMode, setLastMode] = useState<ExecutionMode | null>(null);
  // Honors the user's view mode: an external wallet in EOA view signs from the
  // EOA (where the funds are); SA view (or an in-app wallet) signs from the SA.
  const writer = useWriteAccount();

  /** True when the signer can bundle every call into one sponsored userop. */
  const canBatch = Boolean(writer?.account.sendBatchTransaction);

  const execute = async (
    coins: CoinToMigrate[],
    { depositIntoMigration, slippage = MIGRATION_SLIPPAGE }: ExecuteOptions,
  ): Promise<ExecuteResult | undefined> => {
    if (coins.length === 0) return;
    if (!writer) {
      toast.error("Please connect your wallet");
      return;
    }
    const client = getThirdwebClient();
    if (!client) {
      toast.error("Thirdweb client not configured");
      return;
    }
    if (depositIntoMigration && !isMigrationDepositLive()) {
      toast.error("The migration deposit is not open");
      return;
    }

    const mode: ExecutionMode = writer.account.sendBatchTransaction ? "batch" : "sequential";
    setLastMode(mode);
    setIsRunning(true);

    const initial: MigrationStep[] = [
      ...coins.map((c) => ({ label: `${c.symbol} → ETH`, status: "pending" as StepStatus })),
      ...(depositIntoMigration
        ? [{ label: "ETH → migration deposit", status: "pending" as StepStatus }]
        : []),
    ];
    setSteps(initial);
    const depositIdx = depositIntoMigration ? coins.length : -1;
    const setStatus = (i: number, status: StepStatus) =>
      setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, status } : s)));
    const setAll = (status: StepStatus, only?: (i: number) => boolean) =>
      setSteps((prev) => prev.map((s, i) => (!only || only(i) ? { ...s, status } : s)));

    const sender = writer.account.address as Address;
    const toastId = toast.loading(
      depositIntoMigration ? "Consolidating and depositing…" : "Consolidating to ETH…",
    );

    try {
      const result =
        mode === "batch"
          ? await runBatch({
              coins,
              account: writer.account,
              sender,
              slippage,
              depositIntoMigration,
              setAll,
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

      toast.success(
        depositIntoMigration
          ? "Consolidated and deposited into the migration"
          : "Consolidated into ETH",
        { id: toastId },
      );
      return { ok: true, mode, deposited: result.deposited };
    } catch (err) {
      const { message } = normalizeTxError(err);
      toast.error(message || "Migration failed", { id: toastId });
      return { ok: false, mode, deposited: 0n };
    } finally {
      setIsRunning(false);
    }
  };

  /** Sell the coins and deposit the proceeds — the presale entry, in one run. */
  const swapAndDeposit = (coins: CoinToMigrate[], slippage?: number) =>
    execute(coins, { depositIntoMigration: true, slippage });

  return { execute, swapAndDeposit, isRunning, steps, canBatch, lastMode };
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
  return {
    quote,
    slippage,
    marginBps,
    minOut: minOutAtMargin(BigInt(quote.quote.amountOut), marginBps),
  };
}

async function runBatch({
  coins,
  account,
  sender,
  slippage,
  depositIntoMigration,
  setAll,
}: {
  coins: CoinToMigrate[];
  account: WriterAccount["account"];
  sender: Address;
  slippage: number;
  depositIntoMigration: boolean;
  setAll: (status: StepStatus, only?: (i: number) => boolean) => void;
}): Promise<{ deposited: bigint }> {
  const client = getThirdwebClient()!;
  const expiration = Math.floor(Date.now() / 1000) + PERMIT2_EXPIRY_SECONDS;
  const transactions = [];
  let minOut = 0n;

  setAll("active");
  for (const coin of coins) {
    const amountIn = BigInt(coin.balance);
    const { quote, minOut: coinMinOut } = await quoteToEth(coin, sender, slippage);
    const router = quote.call.target as Address;
    const stripped = stripPermitFromRouterCall(quote.call.data as Hex);
    minOut += coinMinOut;

    const coinContract = getContract({ client, chain: base, address: coin.address });
    transactions.push(
      prepareContractCall({
        contract: coinContract,
        method: ERC20_APPROVE,
        params: [PERMIT2_ADDRESS, amountIn],
      }),
      prepareContractCall({
        contract: getContract({ client, chain: base, address: PERMIT2_ADDRESS }),
        method: PERMIT2_APPROVE,
        params: [coin.address, router, amountIn, expiration],
      }),
      prepareTransaction({
        client,
        chain: base,
        to: router,
        data: stripped.data,
        value: BigInt(quote.call.value),
      }),
    );
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
  try {
    const result = await sendBatchTransaction({ account, transactions });
    await waitForReceipt({ client, chain: base, transactionHash: result.transactionHash });
  } catch (err) {
    setAll("failed");
    throw err;
  }
  setAll("done");
  return { deposited: depositIntoMigration ? minOut : 0n };
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
}): Promise<{ deposited: bigint }> {
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

  let minOut = 0n;
  let soldAny = false;
  for (let i = 0; i < coins.length; i++) {
    setStatus(i, "active");
    try {
      const routeQuote = await quoteToEth(coins[i], sender, slippage);
      await tradeCoin({
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
      });
      minOut += routeQuote.minOut;
      soldAny = true;
      setStatus(i, "done");
    } catch (err) {
      console.error(`[migration] swap failed for ${coins[i].symbol}`, err);
      setStatus(i, "failed");
    }
  }
  if (!soldAny) throw new Error("None of the coins could be sold to ETH");
  if (!depositIntoMigration) return { deposited: 0n };

  setStatus(depositIdx, "active");
  try {
    const transaction = prepareContractCall({
      contract: getContract({ client, chain: base, address: UPGRADER_ADDRESS as Address }),
      ...depositCall(MIGRATION_UPGRADE_ID as bigint, sender, minOut),
    });
    const result = await sendTransaction({ account: writer.account, transaction });
    await waitForReceipt({ client, chain: base, transactionHash: result.transactionHash });
    setStatus(depositIdx, "done");
  } catch (err) {
    setStatus(depositIdx, "failed");
    throw err;
  }
  return { deposited: minOut };
}
