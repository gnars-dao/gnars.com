"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { sendTransaction } from "thirdweb";
import { viemAdapter } from "thirdweb/adapters/viem";
import { ethereum } from "thirdweb/chains";
import {
  erc20Abi,
  formatUnits,
  isAddressEqual,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { useWriteAccount, type WriteAccount } from "@/hooks/use-write-account";
import { prepareTransaction } from "@/lib/builder-code";
import { CACHE_TAGS } from "@/lib/cache-tags";
import { predictSplitAddress } from "@/lib/mor-split";
import {
  depositPoolAbi,
  MORPHEUS_DISTRIBUTOR,
  MORPHEUS_POOLS,
  type MorpheusAsset,
} from "@/lib/morpheus";
import {
  MorpheusStakeController,
  stakeCall,
  stakeJournalKey,
  StakeNotSentError,
  type MorpheusStakeFlow,
  type StakeIntent,
} from "@/lib/morpheus-stake-flow";
import { requestRevalidation } from "@/lib/request-revalidation";
import { getThirdwebClient } from "@/lib/thirdweb";
import { ensureOnChain, normalizeTxError } from "@/lib/thirdweb-tx";

type Entry = { controller: MorpheusStakeController; signers: Set<() => WriteAccount | undefined> };
// Controllers outlive component remounts so an unresolved wallet promise keeps
// the same account/pool locked and can persist a late transaction hash safely.
const controllers = new Map<string, Entry>();
const refreshedTransactions = new Set<string>();

function publicClient(): PublicClient {
  const client = getThirdwebClient();
  if (!client) throw new Error("Wallet client is not configured");
  return viemAdapter.publicClient.toViem({ chain: ethereum, client }) as unknown as PublicClient;
}

function entryFor(account: Address, asset: MorpheusAsset): Entry {
  const key = stakeJournalKey(account, MORPHEUS_POOLS[asset].pool);
  const existing = controllers.get(key);
  if (existing) return existing;
  const signers = new Set<() => WriteAccount | undefined>();
  const writerFor = () => {
    for (const getWriter of signers) {
      const writer = getWriter();
      const actual = writer?.wallet.getAccount()?.address;
      if (
        writer &&
        actual &&
        isAddressEqual(writer.account.address as Address, account) &&
        isAddressEqual(actual as Address, account)
      )
        return writer;
    }
    throw new StakeNotSentError(
      "The connected signer changed. Return to the account that started this attempt.",
    );
  };
  const controller = new MorpheusStakeController(account, asset, {
    storage: window.localStorage,
    validateIntent: async (flow) => {
      const decimals = MORPHEUS_POOLS[flow.asset].decimals;
      if (
        !/^\d+(\.\d+)?$/.test(flow.amount) ||
        (flow.amount.split(".")[1]?.length ?? 0) > decimals ||
        parseUnits(flow.amount, decimals).toString() !== flow.amountRaw
      )
        throw new Error("Saved amount does not match the transaction amount");
      if (!Number.isSafeInteger(flow.claimLockEnd) || flow.claimLockEnd < 0)
        throw new Error("Invalid saved claim lock");
      const receiver = await predictSplitAddress(flow.account, flow.athlete);
      if (!isAddressEqual(receiver, flow.expectedReceiver))
        throw new Error("Saved claim receiver does not match the account and rider");
    },
    snapshotBlock: () => publicClient().getBlockNumber({ cacheTime: 0 }),
    lock: async (name, action) => {
      if (!navigator.locks)
        throw new Error(
          "This browser cannot safely coordinate wallet requests. Use a browser with Web Locks support.",
        );
      return await navigator.locks.request(name, () => action());
    },
    allowance: (flow) =>
      publicClient().readContract({
        address: MORPHEUS_POOLS[flow.asset].token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [flow.account, MORPHEUS_DISTRIBUTOR],
      }),
    position: async (flow) => {
      const client = publicClient();
      const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
      const [data, receiver] = await Promise.all([
        client.readContract({
          address: flow.pool,
          abi: depositPoolAbi,
          functionName: "usersData",
          args: [flow.account, 0n],
          blockNumber,
        }),
        client.readContract({
          address: flow.pool,
          abi: depositPoolAbi,
          functionName: "claimReceiver",
          args: [0n, flow.account],
          blockNumber,
        }),
      ]);
      return { deposited: data[1], referrer: data[8], receiver, claimLockEnd: Number(data[5]) };
    },
    transaction: async (hash) => {
      try {
        const tx = await publicClient().getTransaction({ hash });
        return {
          chainId: tx.chainId ?? 1,
          from: tx.from,
          to: tx.to,
          input: tx.input,
          value: tx.value,
          blockNumber: tx.blockNumber,
        };
      } catch (error) {
        if (error instanceof Error && error.name === "TransactionNotFoundError") return null;
        throw error;
      }
    },
    receipt: async (hash) => {
      try {
        const receipt = await publicClient().getTransactionReceipt({ hash });
        return { status: receipt.status, logs: receipt.logs };
      } catch (error) {
        if (error instanceof Error && error.name === "TransactionReceiptNotFoundError") return null;
        throw error;
      }
    },
    send: async (step, flow) => {
      const writer = writerFor();
      try {
        await ensureOnChain(writer.wallet, ethereum);
      } catch (error) {
        throw new StakeNotSentError(normalizeTxError(error).message);
      }
      if (writerFor().account !== writer.account)
        throw new StakeNotSentError("The connected account changed before signing");
      const client = getThirdwebClient();
      if (!client) throw new StakeNotSentError("Wallet client is not configured");
      const call = stakeCall(flow, step);
      const transaction = prepareTransaction({
        client,
        chain: ethereum,
        to: call.to,
        data: call.data,
      });
      try {
        const result = await sendTransaction({ account: writer.account, transaction });
        return result.transactionHash;
      } catch (error) {
        if (normalizeTxError(error).category === "user-rejected")
          throw new StakeNotSentError("Transaction cancelled in the wallet");
        throw error;
      }
    },
  });
  const entry = { controller, signers };
  controllers.set(key, entry);
  return entry;
}

export function useMorpheusStakeFlow({
  asset,
  athlete,
  enabled = true,
}: {
  asset: MorpheusAsset;
  athlete?: Address;
  enabled?: boolean;
}) {
  const writer = useWriteAccount();
  const queryClient = useQueryClient();
  const account = writer?.account.address as Address | undefined;
  const writerRef = useRef(writer);
  const controllerRef = useRef<MorpheusStakeController | null>(null);
  const [flow, setFlow] = useState<MorpheusStakeFlow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  useEffect(() => {
    writerRef.current = writer;
  }, [writer]);

  const bootstrap = useCallback(
    async (controller: MorpheusStakeController, active: () => boolean = () => true) => {
      if (controller.flow) {
        await controller.checkStatus();
        return;
      }
      if (!account || !athlete) return;
      const pool = MORPHEUS_POOLS[asset];
      const data = await publicClient().readContract({
        address: pool.pool,
        abi: depositPoolAbi,
        functionName: "usersData",
        args: [account, 0n],
      });
      if (!active() || data[1] <= 0n || !isAddressEqual(data[8], athlete)) return;
      const expectedReceiver = await predictSplitAddress(account, athlete);
      if (!active()) return;
      await controller.discoverRecovery({
        account,
        asset,
        pool: pool.pool,
        athlete,
        amount: formatUnits(data[1], pool.decimals),
        amountRaw: data[1].toString(),
        claimLockEnd: Number(data[5]),
        expectedReceiver,
      });
    },
    [account, asset, athlete],
  );

  useEffect(() => {
    let disposed = false;
    controllerRef.current = null;
    setFlow(null);
    setError(null);
    setLoading(false);
    setIsBusy(false);
    if (!account || !enabled) return;
    let unsubscribe: (() => void) | undefined;
    let entry: Entry | undefined;
    const signer = () => writerRef.current;
    setLoading(true);
    void (async () => {
      entry = entryFor(account, asset);
      entry.signers.add(signer);
      const controller = entry.controller;
      controllerRef.current = controller;
      const sync = () => {
        if (disposed) return;
        setFlow(controller.flow ? { ...controller.flow } : null);
        setIsBusy(controller.isBusy);
        setError(controller.flow?.error ?? null);
      };
      unsubscribe = controller.subscribe(sync);
      sync();
      await bootstrap(controller, () => !disposed);
      sync();
    })()
      .catch((reason) => {
        if (!disposed)
          setError(reason instanceof Error ? reason.message : "Unable to read the stake position");
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
      unsubscribe?.();
      entry?.signers.delete(signer);
    };
  }, [account, asset, bootstrap, enabled]);

  const invoke = useCallback(
    async (action: (controller: MorpheusStakeController) => Promise<void>) => {
      const controller = controllerRef.current;
      if (!controller) {
        setError("Connect the account that owns this stake");
        return;
      }
      setError(null);
      try {
        await action(controller);
      } catch (reason) {
        const currentAccount = writerRef.current?.account.address;
        if (
          controllerRef.current === controller &&
          currentAccount &&
          isAddressEqual(currentAccount as Address, controller.account)
        )
          setError(
            reason instanceof Error ? reason.message : "Unable to continue this stake attempt",
          );
      }
    },
    [],
  );

  const start = useCallback(
    async (amount: string, claimLockEnd = 0) => {
      await invoke(async (controller) => {
        if (!athlete || !account || !isAddressEqual(controller.account, account))
          throw new Error("Select a rider and connect your wallet");
        const pool = MORPHEUS_POOLS[asset];
        const amountRaw = parseUnits(amount, pool.decimals);
        if (amountRaw < parseUnits(pool.minStake, pool.decimals))
          throw new Error(`Minimum deposit is ${pool.minStake} ${pool.symbol}`);
        const expectedReceiver = await predictSplitAddress(account, athlete);
        const intent: StakeIntent = {
          account,
          asset,
          pool: pool.pool,
          athlete,
          amount,
          amountRaw: amountRaw.toString(),
          claimLockEnd,
          expectedReceiver,
        };
        await controller.start(intent);
      });
    },
    [account, asset, athlete, invoke],
  );
  const continueFlow = useCallback(
    () => invoke((controller) => controller.continueFlow()),
    [invoke],
  );
  const checkStatus = useCallback(async () => {
    setIsChecking(true);
    try {
      await invoke((controller) => bootstrap(controller));
    } finally {
      setIsChecking(false);
    }
  }, [invoke, bootstrap]);
  const recoverReceiver = useCallback(
    () =>
      invoke(async (controller) => {
        if (!controller.flow?.depositConfirmed || controller.flow.step !== "receiver")
          throw new Error("No confirmed position is available for receiver recovery");
        await controller.continueFlow();
      }),
    [invoke],
  );
  const attachHash = useCallback(
    async (hash: Hex) => {
      setIsChecking(true);
      try {
        await invoke((controller) => controller.attachHash(hash));
      } finally {
        setIsChecking(false);
      }
    },
    [invoke],
  );
  const clearCompleted = useCallback(() => {
    void invoke((controller) => controller.clearCompleted());
  }, [invoke]);

  useEffect(() => {
    if (
      !enabled ||
      !flow ||
      !flow.hashes[flow.step] ||
      !["pending", "confirming"].includes(flow.status)
    )
      return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void checkStatus();
    }, 5000);
    return () => clearInterval(timer);
  }, [enabled, flow, checkStatus]);

  const visibleFlow =
    enabled && account && flow && flow.asset === asset && isAddressEqual(flow.account, account)
      ? flow
      : null;

  useEffect(() => {
    if (!visibleFlow) return;
    const hashes = [
      visibleFlow.depositConfirmed ? visibleFlow.hashes.deposit : undefined,
      visibleFlow.status === "complete" ? visibleFlow.hashes.receiver : undefined,
    ];
    for (const hash of hashes) {
      if (!hash || refreshedTransactions.has(hash)) continue;
      refreshedTransactions.add(hash);
      requestRevalidation([CACHE_TAGS.stake], { transactionHash: hash, chainId: 1 });
      void queryClient.invalidateQueries({ queryKey: ["morpheus-position", visibleFlow.account] });
    }
  }, [queryClient, visibleFlow]);

  return {
    flow: visibleFlow,
    loading,
    error,
    isBusy,
    isChecking,
    start,
    continueFlow,
    checkStatus,
    recoverReceiver,
    clearCompleted,
    attachHash,
  };
}
