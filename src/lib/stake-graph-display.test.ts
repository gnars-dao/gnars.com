import { describe, expect, it } from "vitest";
import type { OrbitBacker } from "@/services/stake-graph";
import { formatMorpheusPrincipal, hasVerifiedRewardRouting } from "./stake-graph-display";

const backer: OrbitBacker = {
  address: "0x1111111111111111111111111111111111111111",
  amount: 140,
  kind: "mor",
  asset: "steth",
  tokenAmount: "0.07",
  routing: "unconfigured",
};

describe("orbit principal and reward routing", () => {
  it("shows the deposited token amount separately from its USD valuation", () => {
    expect(formatMorpheusPrincipal(backer, "pt-br")).toBe("0,07 stETH");
    expect(formatMorpheusPrincipal(backer, "en")).toBe("0.07 stETH");
    expect(backer.amount).toBe(140);
  });
  it.each(["unconfigured", "custom", "unknown", undefined] as const)(
    "does not animate unverified %s routing as treasury rewards",
    (routing) => {
      expect(hasVerifiedRewardRouting({ ...backer, routing })).toBe(false);
    },
  );
  it("recognizes verified splits and vault routing", () => {
    expect(hasVerifiedRewardRouting({ ...backer, routing: "verified-split" })).toBe(true);
    expect(hasVerifiedRewardRouting({ ...backer, kind: "vault" })).toBe(true);
  });
  it("does not invent token units for legacy or malformed data", () => {
    expect(formatMorpheusPrincipal({ ...backer, tokenAmount: undefined }, "pt-br")).toBeNull();
    expect(formatMorpheusPrincipal({ ...backer, tokenAmount: "NaN" }, "pt-br")).toBeNull();
    expect(formatMorpheusPrincipal({ ...backer, kind: "vault" }, "pt-br")).toBeNull();
  });
});
