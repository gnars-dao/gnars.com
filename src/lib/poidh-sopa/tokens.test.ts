import { describe, expect, it } from "vitest";
import {
  findSopaToken,
  formatSopaReward,
  formatTokenAmount,
  isEthToken,
  parseTokenAmountInput,
} from "./tokens";

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const ETH = "0x0000000000000000000000000000000000000000";

describe("formatTokenAmount", () => {
  it("formats USDC with 6 decimals", () => {
    expect(formatTokenAmount(250_000_000n, 6, 2)).toBe("250");
    expect(formatTokenAmount("1234567", 6, 2)).toBe("1.23");
    expect(formatTokenAmount(1_500_000_000_000n, 6, 2)).toBe("1,500,000");
  });

  it("truncates instead of rounding up", () => {
    expect(formatTokenAmount(19_999n, 4, 2)).toBe("1.99");
    expect(formatTokenAmount(12_345_678_900_000_000n, 18, 4)).toBe("0.0123");
  });

  it("marks tiny non-zero amounts and keeps zero as zero", () => {
    expect(formatTokenAmount(1n, 18, 4)).toBe("<0.0001");
    expect(formatTokenAmount(0n, 18, 4)).toBe("0");
  });
});

describe("formatSopaReward", () => {
  it("uses the configured symbol and precision", () => {
    expect(formatSopaReward("250000000", USDC)).toBe("250 USDC");
    expect(formatSopaReward("50000000000000000", ETH)).toBe("0.05 ETH");
  });

  it("flags tokens missing from config", () => {
    expect(
      formatSopaReward("1000000000000000000", "0x000000000000000000000000000000000000dEaD"),
    ).toBe("1 ?");
  });
});

describe("parseTokenAmountInput", () => {
  it("parses dots and commas", () => {
    expect(parseTokenAmountInput("250", 6)).toBe(250_000_000n);
    expect(parseTokenAmountInput("0,05", 18)).toBe(50_000_000_000_000_000n);
    expect(parseTokenAmountInput(".5", 6)).toBe(500_000n);
  });

  it("rejects zero, empty and too many decimals", () => {
    expect(parseTokenAmountInput("", 6)).toBeNull();
    expect(parseTokenAmountInput("0", 6)).toBeNull();
    expect(parseTokenAmountInput("0.0000001", 6)).toBeNull();
    expect(parseTokenAmountInput(".", 6)).toBeNull();
  });
});

describe("token lookup", () => {
  it("matches addresses case-insensitively", () => {
    expect(findSopaToken(USDC.toUpperCase().replace("0X", "0x"))?.symbol).toBe("USDC");
    expect(isEthToken(ETH)).toBe(true);
    expect(isEthToken(USDC)).toBe(false);
  });
});
