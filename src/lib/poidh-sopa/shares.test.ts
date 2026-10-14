import { describe, expect, it } from "vitest";
import {
  bpsToPercentString,
  equalSplitBps,
  equalSplitPercents,
  percentsToBps,
  previewPayouts,
  validateWinnerShares,
} from "./shares";

describe("equal split", () => {
  it("puts the remainder on the last winner", () => {
    expect(equalSplitBps(1)).toEqual([10_000]);
    expect(equalSplitBps(3)).toEqual([3333, 3333, 3334]);
    expect(equalSplitBps(7).reduce((a, b) => a + b, 0)).toBe(10_000);
    expect(equalSplitBps(0)).toEqual([]);
  });

  it("renders percent strings with up to 2 decimals", () => {
    expect(equalSplitPercents(3)).toEqual(["33.33", "33.33", "33.34"]);
    expect(bpsToPercentString(5000)).toBe("50");
    expect(bpsToPercentString(1250)).toBe("12.5");
    expect(bpsToPercentString(5)).toBe("0.05");
  });
});

describe("percentsToBps", () => {
  it("rounds the head and gives the last the remainder", () => {
    expect(percentsToBps([50, 50])).toEqual([5000, 5000]);
    expect(percentsToBps([33.333, 33.333, 33.334])).toEqual([3333, 3333, 3334]);
    expect(percentsToBps([100])).toEqual([10_000]);
  });
});

describe("validateWinnerShares", () => {
  it("accepts a valid split", () => {
    const v = validateWinnerShares([4, 9], ["70", "30"]);
    expect(v).toMatchObject({ ok: true, error: null, sharesBps: [7000, 3000] });
  });

  it("accepts comma decimals and absorbs rounding on the last", () => {
    const v = validateWinnerShares([1, 2, 3], ["33,333", "33,333", "33,333"]);
    expect(v.ok).toBe(true);
    expect(v.sharesBps).toEqual([3333, 3333, 3334]);
    expect(v.sharesBps.reduce((a, b) => a + b, 0)).toBe(10_000);
  });

  it("rejects totals that are not 100%", () => {
    expect(validateWinnerShares([1, 2], ["50", "40"]).error).toBe("totalNot100");
    expect(validateWinnerShares([1, 2], ["60", "50"]).error).toBe("totalNot100");
  });

  it("enforces the contract rules", () => {
    expect(validateWinnerShares([], []).error).toBe("noWinners");
    const eleven = Array.from({ length: 11 }, (_, i) => i);
    expect(
      validateWinnerShares(
        eleven,
        eleven.map(() => "9.09"),
      ).error,
    ).toBe("tooManyWinners");
    expect(validateWinnerShares([5, 5], ["50", "50"]).error).toBe("duplicateClaim");
    expect(validateWinnerShares([1, 2], ["100", "0"]).error).toBe("zeroShare");
    expect(validateWinnerShares([1, 2], ["abc", "50"]).error).toBe("invalidNumber");
    expect(validateWinnerShares([1, 2], ["", "100"]).error).toBe("invalidNumber");
  });

  it("allows ten winners", () => {
    const ten = Array.from({ length: 10 }, (_, i) => i + 1);
    expect(validateWinnerShares(ten, equalSplitPercents(10)).ok).toBe(true);
  });
});

describe("previewPayouts", () => {
  it("floors each fee separately and gives dust to the last winner", () => {
    // 100 USDC (6 decimals), POIDH 1.5% + Sopa 1% = 2.5 USDC fees, 97.5 net.
    const total = 100_000_000n;
    const out = previewPayouts(total, [3333, 3333, 3334], [150, 100]);
    expect(out.reduce((a, b) => a + b, 0n)).toBe(97_500_000n);
    expect(out[0]).toBe((97_500_000n * 3333n) / 10_000n);
    expect(out[2]).toBe(97_500_000n - out[0] - out[1]);
  });

  it("matches the contract when there is no fee", () => {
    expect(previewPayouts(10n, [5000, 5000], [0, 0])).toEqual([5n, 5n]);
  });
});
