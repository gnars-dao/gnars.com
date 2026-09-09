import { describe, expect, it } from "vitest";
import { parseMigrationEnv } from "./migration-config";

const ADDR = "0x064fd3d95f322909489dc085bb0044a343191ad3";

describe("parseMigrationEnv", () => {
  it("is off with nothing set", () => {
    expect(parseMigrationEnv({})).toEqual({ upgraderAddress: null, upgradeId: null, error: null });
    expect(parseMigrationEnv({ upgraderAddress: "", upgradeId: " " })).toEqual({
      upgraderAddress: null,
      upgradeId: null,
      error: null,
    });
  });

  it("is on with both set", () => {
    expect(parseMigrationEnv({ upgraderAddress: ADDR, upgradeId: "0" })).toEqual({
      upgraderAddress: ADDR,
      upgradeId: 0n,
      error: null,
    });
  });

  it("reports a malformed address as an error, not as off", () => {
    const r = parseMigrationEnv({ upgraderAddress: "0x064f…1ad3", upgradeId: "0" });
    expect(r.upgraderAddress).toBeNull();
    expect(r.error).toMatch(/NEXT_PUBLIC_UPGRADER_ADDRESS/);
  });

  it("reports a malformed id as an error", () => {
    const r = parseMigrationEnv({ upgraderAddress: ADDR, upgradeId: "zero" });
    expect(r.upgradeId).toBeNull();
    expect(r.error).toMatch(/NEXT_PUBLIC_MIGRATION_UPGRADE_ID/);
  });

  it("reports one-without-the-other as an error", () => {
    expect(parseMigrationEnv({ upgraderAddress: ADDR }).error).toMatch(/UPGRADE_ID is empty/);
    expect(parseMigrationEnv({ upgradeId: "0" }).error).toMatch(/UPGRADER_ADDRESS is empty/);
  });
});
