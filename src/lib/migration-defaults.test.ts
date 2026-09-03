/**
 * The deposit terminal is ON by default (Vlad's go, 2026-09-03). These pin the
 * two facts that decide whether real ETH deposits are reachable, because both
 * are one edit away from silently flipping:
 *   · with no env set at all, the terminal is live and pointed at the verified
 *     contract — a regression here takes the terminal down without failing;
 *   · the env kill switch turns it OFF CLEANLY, not into a red misconfiguration.
 * The second is the subtle one: emptying only the address leaves an id without a
 * contract, which parseMigrationEnv correctly rejects as a mismatched pair.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const ADDR = "0x064fd3d95f322909489dc085bb0044a343191ad3";

async function loadConfig(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) vi.stubEnv(k, undefined as unknown as string);
    else vi.stubEnv(k, v);
  }
  return import("./config");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("migration deposit defaults", () => {
  it("is live with no env set, on the verified contract", async () => {
    const c = await loadConfig({
      NEXT_PUBLIC_UPGRADER_ADDRESS: undefined,
      NEXT_PUBLIC_MIGRATION_UPGRADE_ID: undefined,
    });
    expect(c.UPGRADER_ADDRESS?.toLowerCase()).toBe(ADDR);
    expect(c.MIGRATION_UPGRADE_ID).toBe(0n);
    expect(c.MIGRATION_CONFIG_ERROR).toBeNull();
    expect(c.isMigrationDepositLive()).toBe(true);
  });

  it("turns off cleanly when the address env is emptied — no config error", async () => {
    const c = await loadConfig({
      NEXT_PUBLIC_UPGRADER_ADDRESS: "",
      NEXT_PUBLIC_MIGRATION_UPGRADE_ID: undefined,
    });
    expect(c.isMigrationDepositLive()).toBe(false);
    // The whole point: "off" must not render as "misconfigured".
    expect(c.MIGRATION_CONFIG_ERROR).toBeNull();
  });

  it("lets env override the contract it points at", async () => {
    const other = "0x1111111111166b7FE7bd91427724B487980aFc69";
    const c = await loadConfig({
      NEXT_PUBLIC_UPGRADER_ADDRESS: other,
      NEXT_PUBLIC_MIGRATION_UPGRADE_ID: "7",
    });
    expect(c.UPGRADER_ADDRESS?.toLowerCase()).toBe(other.toLowerCase());
    expect(c.MIGRATION_UPGRADE_ID).toBe(7n);
    expect(c.isMigrationDepositLive()).toBe(true);
  });
});
