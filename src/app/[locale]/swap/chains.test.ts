import { describe, expect, it } from "vitest";
import { SWAPPRO_CHAINS } from "@/lib/swappro";
import { GNARS_SWAP_PAYOUT } from "@/lib/config";
import { getDefaultPair, NATIVE_TOKEN, SWAP_CHAINS } from "./chains";

/**
 * The picker and the router have to agree.
 *
 * Every failure below was once shipped: Optimism in the picker that SwapsPro
 * cannot route, a default pair naming a token the chain's list does not carry,
 * and a stablecoin given Ethereum's six decimals on a chain that uses
 * eighteen. None of them is caught by types.
 */
describe("swap chains", () => {
  it("offers exactly the chains SwapsPro routes", () => {
    const offered = SWAP_CHAINS.map((c) => c.id).sort((a, b) => a - b);
    const routed = Object.keys(SWAPPRO_CHAINS)
      .map(Number)
      .sort((a, b) => a - b);
    expect(offered).toEqual(routed);
  });

  it("names the native asset the way SwapsPro resolves it", () => {
    for (const chain of SWAP_CHAINS) {
      const native = chain.tokens.find((t) => t.address === NATIVE_TOKEN);
      expect(native, `${chain.name} has no native token`).toBeDefined();
      expect(native?.symbol).toBe(SWAPPRO_CHAINS[chain.id].native);
      expect(native?.decimals).toBe(18);
    }
  });

  it("resolves both default symbols to real entries in the chain's own list", () => {
    for (const chain of SWAP_CHAINS) {
      const { sell, buy } = getDefaultPair(chain);
      expect(sell.symbol, `${chain.name} default sell`).toBe(chain.defaults.sell);
      expect(buy.symbol, `${chain.name} default buy`).toBe(chain.defaults.buy);
      expect(sell.address).not.toBe(buy.address);
    }
  });

  it("carries no duplicate symbol or address inside one chain", () => {
    for (const chain of SWAP_CHAINS) {
      const symbols = chain.tokens.map((t) => t.symbol);
      const addresses = chain.tokens.map((t) => t.address.toLowerCase());
      expect(new Set(symbols).size, `${chain.name} symbols`).toBe(symbols.length);
      expect(new Set(addresses).size, `${chain.name} addresses`).toBe(addresses.length);
    }
  });

  it("gives BNB Chain's stables eighteen decimals, not Ethereum's six", () => {
    const bnb = SWAP_CHAINS.find((c) => c.id === 56);
    for (const symbol of ["USDT", "USDC"]) {
      expect(bnb?.tokens.find((t) => t.symbol === symbol)?.decimals, symbol).toBe(18);
    }
  });

  it("only claims a treasury payout on a chain the treasury can be paid on", () => {
    for (const id of Object.keys(GNARS_SWAP_PAYOUT).map(Number)) {
      expect(
        SWAP_CHAINS.some((c) => c.id === id),
        `payout configured for chain ${id}, which the picker does not offer`,
      ).toBe(true);
    }
  });
});

describe("chain marks", () => {
  it("gives every chain an icon keyed to its own id", () => {
    for (const chain of SWAP_CHAINS) {
      expect(chain.logo, chain.name).toContain(`/icons/${chain.id}/`);
    }
  });
});
