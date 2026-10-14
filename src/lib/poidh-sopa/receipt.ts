import { isAddressEqual, parseEventLogs, type Log } from "viem";
import { POIDH_SOPA_ABI } from "./abi";

/**
 * The new bounty id from a confirmed create receipt. Smart-account receipts carry the
 * whole userop's logs (EntryPoint, approve, …), so filter by emitter and event.
 * Returns null when no `BountyCreated` from `contractAddress` is present.
 */
export function extractCreatedBountyId(
  logs: readonly Pick<Log, "address" | "data" | "topics">[],
  contractAddress: `0x${string}`,
): number | null {
  const parsed = parseEventLogs({
    abi: POIDH_SOPA_ABI,
    eventName: "BountyCreated",
    logs: logs.filter((l) => isAddressEqual(l.address, contractAddress)) as Log[],
    strict: true,
  });
  const first = parsed[0];
  return first ? Number(first.args.id) : null;
}
