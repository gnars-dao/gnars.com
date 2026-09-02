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
 * msg.value. `user` must equal msg.sender, so every call is made by the signing
 * account for itself — and the hook refuses to run if the account that signs is
 * not the address the terminal is reading, instead of letting the contract
 * revert with a generic "Not authorized".
 *
 * A transaction that was broadcast is never reported as failed: if the receipt
 * watch times out or the RPC drops, the hash is kept and shown, the position
 * is refetched, and the toast says "sent, confirmation pending".
 */
import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { getContract, sendTransaction, waitForReceipt } from "thirdweb";
import { base } from "thirdweb/chains";
import { isAddressEqual, type Address, type Hex } from "viem";
import { useUserAddress } from "@/hooks/use-user-address";
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

/** What happened to the last write. `sent` = broadcast, receipt not seen. */
export type WriteOutcome = "confirmed" | "sent" | "failed" | "cancelled" | "refused";

export function useUpgradeDeposit() {
  const t = useTranslations("migrate");
  const writer = useWriteAccount();
  const { address: readAddress } = useUserAddress();
  const [running, setRunning] = useState<Action | null>(null);
  const [lastTx, setLastTx] = useState<{ hash: Hex; action: Action; confirmed: boolean } | null>(
    null,
  );

  const run = useCallback(
    async (action: Action, amount: bigint): Promise<WriteOutcome> => {
      if (!isMigrationDepositLive()) {
        toast.error(t("toasts.notOpen"));
        return "refused";
      }
      if (!writer) {
        toast.error(t("toasts.connect"));
        return "refused";
      }
      if (action !== "claim" && amount <= 0n) {
        toast.error(t("toasts.enterAmount"));
        return "refused";
      }
      const client = getThirdwebClient();
      if (!client) {
        toast.error(t("toasts.clientMissing"));
        return "refused";
      }
      // The invariant: the address the terminal reads for MUST be the account
      // that signs. If thirdweb's wallet state and the view mode ever disagree
      // (a wallet-side disconnect, a stale tab), refuse loudly here.
      const user = writer.account.address as Address;
      if (!readAddress || !isAddressEqual(user, readAddress as Address)) {
        toast.error(t("toasts.signerMismatch"));
        return "refused";
      }

      setRunning(action);
      const toastId = toast.loading(t(`toasts.${action}Loading`));
      let hash: Hex | undefined;
      try {
        await ensureOnChain(writer.wallet, base);
        const contract = getContract({ client, chain: base, address: UPGRADER_ADDRESS as Address });
        const id = MIGRATION_UPGRADE_ID as bigint;
        const transaction =
          action === "deposit"
            ? prepareContractCall({ contract, ...depositCall(id, user, amount) })
            : action === "withdraw"
              ? prepareContractCall({ contract, ...withdrawCall(id, user, amount) })
              : prepareContractCall({ contract, ...claimCall(id, user) });

        const result = await sendTransaction({ account: writer.account, transaction });
        hash = result.transactionHash as Hex;
        setLastTx({ hash, action, confirmed: false });
      } catch (err) {
        const { message, category } = normalizeTxError(err);
        if (category === "user-rejected") {
          toast.info(t("toasts.cancelled"), { id: toastId });
          return "cancelled";
        }
        toast.error(t(`toasts.${action}Failed`), { id: toastId, description: message });
        return "failed";
      } finally {
        if (!hash) setRunning(null);
      }

      // Broadcast happened. From here on nothing is a failure of the deposit —
      // only of our ability to see it.
      try {
        await waitForReceipt({ client, chain: base, transactionHash: hash });
        setLastTx({ hash, action, confirmed: true });
        toast.success(t(`toasts.${action}Success`), { id: toastId });
        return "confirmed";
      } catch {
        toast.warning(t("toasts.sentPending"), {
          id: toastId,
          description: hash,
          duration: 15_000,
        });
        return "sent";
      } finally {
        setRunning(null);
      }
    },
    [writer, readAddress, t],
  );

  const deposit = useCallback(({ amount }: DepositArgs) => run("deposit", amount), [run]);
  const withdraw = useCallback(({ amount }: DepositArgs) => run("withdraw", amount), [run]);
  const claim = useCallback(() => run("claim", 0n), [run]);

  return { deposit, withdraw, claim, running, isRunning: running !== null, lastTx };
}
