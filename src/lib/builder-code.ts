import {
  prepareContractCall as thirdwebPrepareContractCall,
  prepareTransaction as thirdwebPrepareTransaction,
  type PreparedTransaction,
} from "thirdweb";
import type { SmartWalletOptions } from "thirdweb/wallets/smart";
import { BUILDER_CODE_SUFFIX } from "@/lib/config";

/**
 * Drop-in replacements for thirdweb's `prepareContractCall` / `prepareTransaction`
 * that tag every transaction with the Gnars Builder Code, so Base attributes the
 * activity to us (see `BUILDER_CODE_SUFFIX` in `@/lib/config` for the wire format).
 *
 * Import these instead of the thirdweb originals — an ESLint rule enforces it, so
 * new write paths get attribution without anyone remembering to ask for it.
 *
 * All they do is set `extraCallData`; thirdweb's `encode()` then does
 * `concatHex([data, extraCallData])` when it builds the final calldata. Contracts
 * ignore the trailing bytes, which is the whole premise of ERC-8021.
 *
 * Smart-account writes additionally use builderCodeAccountOverrides below:
 * ERC-4337 attribution belongs at the end of userOp.callData, outside the
 * account's ABI-encoded execute/executeBatch arguments.
 */
export const prepareContractCall: typeof thirdwebPrepareContractCall = (options) =>
  thirdwebPrepareContractCall({ ...options, extraCallData: BUILDER_CODE_SUFFIX });

export const prepareTransaction: typeof thirdwebPrepareTransaction = (options, info) =>
  thirdwebPrepareTransaction({ ...options, extraCallData: BUILDER_CODE_SUFFIX }, info);

/**
 * Tags an already-prepared transaction. Prefer the wrappers above; this is for
 * transactions handed to us fully built, where there is no prepare call to swap.
 */
export function withBuilderCode<T extends PreparedTransaction>(transaction: T): T {
  return { ...transaction, extraCallData: BUILDER_CODE_SUFFIX };
}

/** Preserve thirdweb's pinned account ABI and gas behavior while tagging the userop. */
export const builderCodeAccountOverrides: Pick<
  NonNullable<SmartWalletOptions["overrides"]>,
  "execute" | "executeBatch"
> = {
  execute: (contract, transaction) =>
    prepareContractCall({
      contract,
      gas: transaction.gas ? transaction.gas + 21_000n : undefined,
      method: "function execute(address, uint256, bytes)",
      params: [transaction.to || "", transaction.value || 0n, transaction.data || "0x"],
    }),
  executeBatch: (contract, transactions) =>
    prepareContractCall({
      contract,
      method: "function executeBatch(address[], uint256[], bytes[])",
      params: [
        transactions.map((transaction) => transaction.to || ""),
        transactions.map((transaction) => transaction.value || 0n),
        transactions.map((transaction) => transaction.data || "0x"),
      ],
    }),
};
