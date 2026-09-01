import type { PreparedTransaction } from "thirdweb";
import { BUILDER_CODE_SUFFIX } from "@/lib/config";

/**
 * Tags a prepared transaction with the Gnars Builder Code so Base attributes it
 * to us (see `BUILDER_CODE_SUFFIX` in `@/lib/config` for the wire format).
 *
 * thirdweb's `encode()` does `concatHex([data, extraCallData])` when building
 * the final calldata, so setting `extraCallData` is all that's needed — there is
 * no need to hand-splice `data`.
 *
 * ```ts
 * const tx = withBuilderCode(
 *   prepareContractCall({ contract, method: "function delegate(address)", params: [to] }),
 * );
 * ```
 *
 * Two things to know before spreading this across write paths:
 *
 * - **Never wrap calldata built by a third party.** Quotes from the 0x Swap API
 *   and anything else that signs or hashes its own calldata can reject the extra
 *   bytes. Only tag calls this app encodes itself.
 * - **Smart-account writes are unverified.** Under `sponsorGas` the call is
 *   wrapped in a userop, so the suffix lands on the inner `execute()` calldata
 *   rather than the top-level transaction. Whether Base's indexer credits that
 *   is an open question — see `/debug/builder-code`.
 */
export function withBuilderCode<T extends PreparedTransaction>(transaction: T): T {
  return { ...transaction, extraCallData: BUILDER_CODE_SUFFIX };
}
