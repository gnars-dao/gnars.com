import type { UpgraderPosition } from "@/hooks/use-upgrader-position";
import { isMigrationDepositLive, MIGRATION_CONFIG_ERROR } from "@/lib/config";

/**
 * The single source of truth for the deposit window's status, shared by the
 * page's status chip and the widget so the two can never disagree.
 */
export type DepositStatusKey =
  | "misconfigured"
  | "opensAtLaunch"
  | "readFailed"
  | "checking"
  | "halted"
  | "executed"
  | "live";

export function depositStatusKey(position: UpgraderPosition): DepositStatusKey {
  if (MIGRATION_CONFIG_ERROR) return "misconfigured";
  if (!isMigrationDepositLive()) return "opensAtLaunch";
  if (position.isError) return "readFailed";
  // Not read yet is not "live". Say so until the contract has answered.
  if (position.isLoading || position.halted === undefined || position.executed === undefined)
    return "checking";
  if (position.halted) return "halted";
  if (position.executed) return "executed";
  return "live";
}

/** Tone of the status dot: green only when deposits are provably open. */
export function depositStatusTone(key: DepositStatusKey): "ok" | "bad" | "idle" {
  switch (key) {
    case "live":
      return "ok";
    case "misconfigured":
    case "readFailed":
    case "halted":
      return "bad";
    default:
      return "idle";
  }
}
