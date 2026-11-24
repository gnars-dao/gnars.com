"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { getContract, sendBatchTransaction, sendTransaction } from "thirdweb";
import { base } from "thirdweb/chains";
import { useActiveAccount, useActiveWallet, useAdminWallet } from "thirdweb/react";
import type { Account, Wallet } from "thirdweb/wallets";
import { useReadContracts } from "wagmi";
import { useUserAddress } from "@/hooks/use-user-address";
import { prepareContractCall } from "@/lib/builder-code";
import { POIDH_SOPA } from "@/lib/config";
import { POIDH_SOPA_ABI } from "@/lib/poidh-sopa/abi";
import { decodeSopaError, type SopaErrorKey } from "@/lib/poidh-sopa/errors";
import {
  groupPending,
  ownedSopaAccounts,
  totalsByToken,
  type PendingRead,
  type SopaAccountKind,
  type SopaPendingAccount,
  type SopaPendingItem,
} from "@/lib/poidh-sopa/withdrawals";
import { getThirdwebClient } from "@/lib/thirdweb";
import { ensureOnChain, waitForSuccessfulReceipt } from "@/lib/thirdweb-tx";

/**
 * PoidhSopa winnings, refunds and withdrawn contributions waiting to be pulled, across the
 * user's smart account AND admin EOA, whatever the view mode. Withdrawing signs with the
 * account that holds each balance (not the view-mode signer), so a winner never has to
 * know which account their claim came from. A smart account batches every token into one
 * sponsored userop; an EOA sends one transaction per token.
 */

export type SopaWithdrawPhase = "idle" | "wallet" | "confirming" | "success" | "error";

export interface SopaWithdrawError {
  /** Translation key under `wallet.prizes.errors` when it has one; else show `message`. */
  key: SopaErrorKey | "noSigner" | null;
  message: string;
}

/** The balance sits in an account this session cannot sign for (e.g. stale wallet). */
class NoSignerError extends Error {}

const REFETCH_MS = 60_000;

/** Signer for one of the user's own accounts, independent of the view mode. */
function useSignerFor() {
  const activeAccount = useActiveAccount();
  const activeWallet = useActiveWallet();
  const adminWallet = useAdminWallet();
  return useCallback(
    (address: string, kind: SopaAccountKind): { account: Account; wallet: Wallet } | null => {
      if (!activeAccount || !activeWallet) return null;
      if (kind === "sa") {
        return activeAccount.address.toLowerCase() === address.toLowerCase()
          ? { account: activeAccount, wallet: activeWallet }
          : null;
      }
      const admin = activeWallet.getAdminAccount?.();
      if (!admin || !adminWallet || admin.address.toLowerCase() !== address.toLowerCase()) {
        return null;
      }
      return { account: admin, wallet: adminWallet };
    },
    [activeAccount, activeWallet, adminWallet],
  );
}

export function useSopaPendingWithdrawals() {
  const { saAddress, adminAddress, isInAppWallet } = useUserAddress();
  const accounts = useMemo(
    () => ownedSopaAccounts({ saAddress, adminAddress: isInAppWallet ? undefined : adminAddress }),
    [saAddress, adminAddress, isInAppWallet],
  );
  const sopa = POIDH_SOPA.address;
  const tokens = POIDH_SOPA.tokens;

  const { data, isLoading, refetch } = useReadContracts({
    allowFailure: true,
    contracts: accounts.flatMap((account) =>
      tokens.map((token) => ({
        address: sopa ?? undefined,
        abi: POIDH_SOPA_ABI,
        functionName: "pendingWithdrawals" as const,
        args: [account.address, token.address] as const,
        chainId: POIDH_SOPA.chainId,
      })),
    ),
    query: { enabled: !!sopa && accounts.length > 0, refetchInterval: REFETCH_MS },
  });

  const grouped = useMemo(
    () =>
      data
        ? groupPending(accounts, tokens, data as readonly PendingRead[])
        : { accounts: [] as SopaPendingAccount[], failed: false },
    [data, accounts, tokens],
  );
  const totals = useMemo(() => totalsByToken(grouped.accounts), [grouped.accounts]);

  return {
    /** Accounts with something to withdraw. */
    pending: grouped.accounts,
    /** Per-token sum across accounts. */
    totals,
    hasPending: totals.length > 0,
    /** Some balance could not be read: say so, never "nothing to withdraw". */
    readFailed: grouped.failed,
    isLoading,
    refetch,
  };
}

export function useSopaWithdrawAll() {
  const signerFor = useSignerFor();
  const [phase, setPhase] = useState<SopaWithdrawPhase>("idle");
  const [error, setError] = useState<SopaWithdrawError | null>(null);
  const [hashes, setHashes] = useState<`0x${string}`[]>([]);
  /** What the last run withdrew (also on a later failure), per receiving address. */
  const [withdrawn, setWithdrawn] = useState<SopaPendingAccount[]>([]);
  /** 1-based transaction count for multi-transaction runs; null for a single send. */
  const [step, setStep] = useState<{ current: number; total: number } | null>(null);

  // A second click during the chain-switch prompt must not start a parallel run.
  const inFlight = useRef(false);

  const run = useCallback(
    async (pending: readonly SopaPendingAccount[]) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPhase("wallet");
      setError(null);
      setHashes([]);
      setWithdrawn([]);
      setStep(null);
      const done: SopaPendingAccount[] = [];
      try {
        const sopa = POIDH_SOPA.address;
        if (!sopa) throw new Error("PoidhSopa is not configured");
        const client = getThirdwebClient();
        if (!client) throw new Error("Thirdweb client not configured");
        const contract = getContract({ client, chain: base, address: sopa, abi: POIDH_SOPA_ABI });

        const plans = pending.map((p) => {
          const signer = signerFor(p.address, p.kind);
          if (!signer) throw new NoSignerError("No signer for " + p.address);
          const batch = p.items.length > 1 && !!signer.account.sendBatchTransaction;
          return { p, signer, sends: batch ? 1 : p.items.length, batch };
        });
        const total = plans.reduce((n, plan) => n + plan.sends, 0);
        let current = 0;

        const confirm = async (hash: `0x${string}`) => {
          setHashes((prev) => [...prev, hash]);
          setPhase("confirming");
          await waitForSuccessfulReceipt({ client, chain: base, transactionHash: hash });
        };

        for (const { p, signer, batch } of plans) {
          await ensureOnChain(signer.wallet, base);
          const txs = p.items.map((item: SopaPendingItem) =>
            prepareContractCall({ contract, method: "withdraw", params: [item.token.address] }),
          );
          // Record each token as its transaction confirms, so a later failure still
          // reports what already went through.
          const entry: SopaPendingAccount = { ...p, items: [] };
          done.push(entry);
          if (batch) {
            current += 1;
            if (total > 1) setStep({ current, total });
            setPhase("wallet");
            const res = await sendBatchTransaction({ account: signer.account, transactions: txs });
            await confirm(res.transactionHash);
            entry.items.push(...p.items);
          } else {
            for (const [i, tx] of txs.entries()) {
              current += 1;
              if (total > 1) setStep({ current, total });
              setPhase("wallet");
              const res = await sendTransaction({ account: signer.account, transaction: tx });
              await confirm(res.transactionHash);
              entry.items.push(p.items[i]);
            }
          }
        }
        setWithdrawn(done);
        setPhase("success");
      } catch (err) {
        setWithdrawn(done.filter((d) => d.items.length > 0));
        setError(
          err instanceof NoSignerError
            ? { key: "noSigner", message: err.message }
            : decodeSopaError(err),
        );
        setPhase("error");
      } finally {
        inFlight.current = false;
      }
    },
    [signerFor],
  );

  return {
    run,
    phase,
    error,
    hashes,
    withdrawn,
    step,
    isPending: phase === "wallet" || phase === "confirming",
    isSuccess: phase === "success",
  };
}
