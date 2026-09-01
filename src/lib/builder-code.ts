import {
  prepareContractCall as thirdwebPrepareContractCall,
  prepareTransaction as thirdwebPrepareTransaction,
  type PreparedTransaction,
} from "thirdweb";
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
 * Verified onchain on Base (2026-09-01) across every calldata shape the app
 * produces — raw value transfer, ABI-encoded arguments, and a bare no-arg selector
 * — signed both directly by an EOA and wrapped in an ERC-4337 userop under
 * sponsored gas. In the userop case the suffix rides on the inner `execute()`
 * calldata rather than the top-level transaction, and Base credits it there too.
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
