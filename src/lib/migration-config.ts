import { isAddress } from "viem";

/**
 * Parses the two env values that turn the UpgraderEth deposit terminal on.
 *
 * Both default to "not set". A malformed value is a configuration failure and is
 * reported as one — the UI shows the error instead of quietly staying gated, so a
 * typo on Vercel can't masquerade as "opens at launch".
 */
export interface MigrationEnv {
  upgraderAddress: `0x${string}` | null;
  upgradeId: bigint | null;
  /** Human-readable reason when a set value could not be parsed. */
  error: string | null;
}

export function parseMigrationEnv(raw: {
  upgraderAddress?: string | null;
  upgradeId?: string | null;
}): MigrationEnv {
  const errors: string[] = [];
  let upgraderAddress: `0x${string}` | null = null;
  let upgradeId: bigint | null = null;

  const addr = raw.upgraderAddress?.trim() ?? "";
  if (addr !== "") {
    if (isAddress(addr)) upgraderAddress = addr as `0x${string}`;
    else errors.push(`NEXT_PUBLIC_UPGRADER_ADDRESS is not an address: "${addr}"`);
  }

  const id = raw.upgradeId?.trim() ?? "";
  if (id !== "") {
    if (/^\d+$/.test(id)) upgradeId = BigInt(id);
    else errors.push(`NEXT_PUBLIC_MIGRATION_UPGRADE_ID is not an unsigned integer: "${id}"`);
  }

  // One without the other is also a misconfiguration: a live id with no
  // contract (or the reverse) can never be right.
  if (errors.length === 0 && (upgraderAddress === null) !== (upgradeId === null)) {
    errors.push(
      upgraderAddress === null
        ? "NEXT_PUBLIC_MIGRATION_UPGRADE_ID is set but NEXT_PUBLIC_UPGRADER_ADDRESS is empty"
        : "NEXT_PUBLIC_UPGRADER_ADDRESS is set but NEXT_PUBLIC_MIGRATION_UPGRADE_ID is empty",
    );
  }

  return { upgraderAddress, upgradeId, error: errors.length ? errors.join("; ") : null };
}
