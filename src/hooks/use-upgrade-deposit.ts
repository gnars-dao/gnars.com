"use client";

/**
 * Gnars Migration — UpgraderEth writes: deposit, withdraw, claim.
 *
 * Signature verified against the live contract (Base, 2026-09-01):
 *   deposit(uint256 upgradeId, address user, address token, uint256 quantity) payable
 *   withdraw(uint256 upgradeId, address user, address token, uint256 quantity) payable
 *   claim(uint256 upgradeId, address user) returns (uint256)
 *
 * ETH is the only eligible token: `token` is address(0) and the ETH rides as
 * msg.value. `user` must equal msg.sender (or a delegate the user registered via
 * addDelegate), so every call here is made by the signing account for itself.
 *
 * The swap → deposit batch lives in use-execute-migration.ts; this hook is the
 * plain terminal for ETH already in the wallet, plus the exit (withdraw, allowed
 * until the operator runs execute) and the claim afterwards.
 */
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { getContract, sendTransaction, waitForReceipt } from "thirdweb";
import { base } from "thirdweb/chains";
import { type Address, type Hex } from "viem";
import { useWriteAccount } from "@/hooks/use-write-account";
import { prepareContractCall } from "@/lib/builder-code";
import { isMigrationDepositLive, MIGRATION_UPGRADE_ID, UPGRADER_ADDRESS } from "@/lib/config";
import { getThirdwebClient } from "@/lib/thirdweb";
import { ensureOnChain, normalizeTxError } from "@/lib/thirdweb-tx";
import { claimCall, depositCall, withdrawCall } from "@/lib/upgrader-calls";

export { UPGRADER_DEPOSIT_METHOD } from "@/lib/upgrader-calls";

export interface DepositArgs {
  /** ETH amount in wei. */
  amount: bigint;
}

type Action = "deposit" | "withdraw" | "claim";

export function useUpgradeDeposit() {
  const writer = useWriteAccount();
  const [running, setRunning] = useState<Action | null>(null);
  const [txHash, setTxHash] = useState<Hex | undefined>(undefined);

  const run = useCallback(
    async (
      action: Action,
      amount: bigint,
      copy: { loading: string; success: string; failed: string },
    ): Promise<boolean> => {
      if (!isMigrationDepositLive()) {
        toast.error("The migration deposit is not open");
        return false;
      }
      if (!writer) {
        toast.error("Please connect your wallet");
        return false;
      }
      if (action !== "claim" && amount <= 0n) {
        toast.error("Enter an amount");
        return false;
      }
      const client = getThirdwebClient();
      if (!client) {
        toast.error("Thirdweb client not configured");
        return false;
      }

      setRunning(action);
      const toastId = toast.loading(copy.loading);
      try {
        await ensureOnChain(writer.wallet, base);
        const user = writer.account.address as Address;
        const contract = getContract({ client, chain: base, address: UPGRADER_ADDRESS as Address });
        const id = MIGRATION_UPGRADE_ID as bigint;

        // `user` is always the signing account (msg.sender) — the contract
        // checks that before anything else. src/lib/upgrader-calls.ts pins the
        // encoding; the test there is the regression guard.
        const transaction =
          action === "deposit"
            ? prepareContractCall({ contract, ...depositCall(id, user, amount) })
            : action === "withdraw"
              ? prepareContractCall({ contract, ...withdrawCall(id, user, amount) })
              : prepareContractCall({ contract, ...claimCall(id, user) });

        const result = await sendTransaction({ account: writer.account, transaction });
        const hash = result.transactionHash as Hex;
        setTxHash(hash);
        await waitForReceipt({ client, chain: base, transactionHash: hash });
        toast.success(copy.success, { id: toastId });
        return true;
      } catch (err) {
        const { message } = normalizeTxError(err);
        toast.error(message || copy.failed, { id: toastId });
        return false;
      } finally {
        setRunning(null);
      }
    },
    [writer],
  );

  const deposit = useCallback(
    ({ amount }: DepositArgs) =>
      run("deposit", amount, {
        loading: "Depositing ETH into the migration…",
        success: "Deposited into the migration",
        failed: "Deposit failed",
      }),
    [run],
  );

  const withdraw = useCallback(
    ({ amount }: DepositArgs) =>
      run("withdraw", amount, {
        loading: "Withdrawing your ETH…",
        success: "Withdrawn from the migration",
        failed: "Withdraw failed",
      }),
    [run],
  );

  const claim = useCallback(
    () =>
      run("claim", 0n, {
        loading: "Claiming your new $gnars…",
        success: "Claimed your new $gnars!",
        failed: "Claim failed",
      }),
    [run],
  );

  return { deposit, withdraw, claim, running, isRunning: running !== null, txHash };
}
