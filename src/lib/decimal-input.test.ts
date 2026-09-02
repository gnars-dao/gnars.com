import { parseEther } from "viem";
import { describe, expect, it } from "vitest";
import { normalizeDecimalInput } from "./decimal-input";

describe("normalizeDecimalInput", () => {
  it("turns a comma decimal into a dot — the Brazilian iPhone keyboard case", () => {
    expect(normalizeDecimalInput("0,05")).toBe("0.05");
    expect(parseEther(normalizeDecimalInput("0,05"))).toBe(50_000_000_000_000_000n);
  });

  it("never collapses '0,005' into 5", () => {
    expect(normalizeDecimalInput("0,005")).toBe("0.005");
    expect(parseEther(normalizeDecimalInput("0,005"))).toBe(5_000_000_000_000_000n);
  });

  it("keeps a dot decimal as is", () => {
    expect(normalizeDecimalInput("0.05")).toBe("0.05");
    expect(normalizeDecimalInput("12")).toBe("12");
  });

  it("keeps only the first separator", () => {
    expect(normalizeDecimalInput("1.2.3")).toBe("1.23");
    expect(normalizeDecimalInput("1,2,3")).toBe("1.23");
    expect(normalizeDecimalInput("1.2,3")).toBe("1.23");
  });

  it("drops letters, spaces and signs", () => {
    expect(normalizeDecimalInput(" 1 000,5 ETH")).toBe("1000.5");
    expect(normalizeDecimalInput("-0,5")).toBe("0.5");
  });

  it("allows a trailing or leading separator while typing", () => {
    expect(normalizeDecimalInput("0,")).toBe("0.");
    expect(normalizeDecimalInput(",5")).toBe(".5");
    expect(normalizeDecimalInput("")).toBe("");
  });
});
