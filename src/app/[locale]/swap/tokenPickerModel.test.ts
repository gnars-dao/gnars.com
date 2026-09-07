import { describe, expect, it } from "vitest";
import type { SwapToken, WalletToken } from "./chains";
import {
  compactTokenBalance,
  filterPickerTokens,
  mergePickerTokens,
  walletPickerTokens,
} from "./tokenPickerModel";

const token: SwapToken = {
  address: "0xAb11111111111111111111111111111111111111",
  symbol: "LONG".repeat(80),
  name: "Long description ".repeat(100),
  decimals: 18,
  logo: "/gnars.webp",
};

describe("token picker model", () => {
  it("merges by address, not by an impersonated name or symbol", () => {
    const result = mergePickerTokens(
      [token],
      [
        {
          ...token,
          address: token.address.toLowerCase() as `0x${string}`,
          logo: undefined,
          category: "creator",
          source: "zora",
        },
      ],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ category: "creator", source: "zora", logo: "/gnars.webp" });
    expect(
      mergePickerTokens(
        [token],
        [{ ...token, address: "0xbb11111111111111111111111111111111111111" }],
      ),
    ).toHaveLength(2);
  });
  it("searches complete long names and case-insensitive addresses locally", () => {
    expect(filterPickerTokens([token], " DESCRIPTION ")).toHaveLength(1);
    expect(filterPickerTokens([token], "0xab111")).toHaveLength(1);
    expect(filterPickerTokens([token], "missing")).toHaveLength(0);
  });
  it("sorts holdings by known USD value, not arbitrary units of unrelated assets", () => {
    const other = {
      ...token,
      address: "0xbb11111111111111111111111111111111111111" as const,
      symbol: "OTHER",
    };
    const balances: WalletToken[] = [token, other].map((t, i) => ({
      ...t,
      balance: i ? "1" : "999999999999",
      displayBalance: "1",
      logoUrl: null,
      usdValue: i ? 100 : null,
    }));
    expect(walletPickerTokens([token, other], balances, new Map([[other.address, 100]]))[0]).toBe(
      other,
    );
    expect(walletPickerTokens([token], [])).toEqual([]);
  });
  it("bounds very large balances while retaining small nonzero values", () => {
    expect(compactTokenBalance("3996443.39", "pt-BR").length).toBeLessThan(12);
    expect(compactTokenBalance("0.000000001", "en")).not.toBe("0");
    expect(compactTokenBalance("bad", "en")).toBe("--");
  });
});
