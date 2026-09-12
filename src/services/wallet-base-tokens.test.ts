import { describe, expect, it } from "vitest";
import type { WalletToken } from "@/app/[locale]/swap/chains";
import {
  hasSpamLabel,
  isPlausibleWalletToken,
  MAX_PLAUSIBLE_TOKEN_UNITS,
} from "./wallet-base-tokens";

const token = (over: Partial<WalletToken> = {}): WalletToken => ({
  address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
  balance: "13514467101",
  displayBalance: "13514.467101",
  logoUrl: null,
  usdValue: 13513.04,
  ...over,
});

describe("isPlausibleWalletToken", () => {
  it("keeps an ordinary Base token", () => {
    expect(isPlausibleWalletToken(token())).toBe(true);
  });

  it("keeps a token with no CoinGecko price — the router decides, not the price feed", () => {
    expect(isPlausibleWalletToken(token({ usdValue: null }))).toBe(true);
  });

  it("drops a token whose known price is below the floor", () => {
    expect(isPlausibleWalletToken(token({ usdValue: 0.4 }))).toBe(false);
  });

  it("drops missing metadata", () => {
    expect(isPlausibleWalletToken(token({ symbol: "  " }))).toBe(false);
    expect(isPlausibleWalletToken(token({ name: "" }))).toBe(false);
  });

  it("drops absurd decimals and absurd supply", () => {
    expect(isPlausibleWalletToken(token({ decimals: 77 }))).toBe(false);
    expect(isPlausibleWalletToken(token({ decimals: 1.5 }))).toBe(false);
    expect(
      isPlausibleWalletToken(
        token({ displayBalance: String(MAX_PLAUSIBLE_TOKEN_UNITS * 10), usdValue: null }),
      ),
    ).toBe(false);
  });

  it("drops zero and unparseable balances", () => {
    expect(isPlausibleWalletToken(token({ balance: "0", displayBalance: "0" }))).toBe(false);
    expect(isPlausibleWalletToken(token({ balance: "not-a-number" }))).toBe(false);
  });

  it("drops an address that is not an address", () => {
    expect(isPlausibleWalletToken(token({ address: "0xnope" }))).toBe(false);
  });
});

describe("hasSpamLabel", () => {
  // Every one of these was returned by a live Alchemy scan of the Gnars
  // treasury on Base — they are the actual shape of the noise, not invented.
  it.each([
    ["Airdrop: degen.gifts/?claim", "Degen"],
    ["Claim: toshi-thecat.com/?claim", "Toshi"],
    ["Collect on: swap-based.com", "BASE"],
    ["Earn rewards on https://alienbase.org", "$ alienbase.org"],
    ["Base Claim Link:Base-Bridge.xyz", "Base Bridge"],
    ["https://RareAddress.com", "Free Rare Address Generator"],
    ["(t.me/s/US_POOL) *claim until 17.0", "✅СIRCLE TOKEN DISTRIBUTION"],
    ["$UЅDС - Redeem: t.ly/cpool - #15", "$UЅDС REWARD:  t.ly/cpool"],
  ])("flags %s", (symbol, name) => {
    expect(hasSpamLabel(symbol, name)).toBe(true);
  });

  it.each([
    ["USDC", "USD Coin"],
    ["WETH", "Wrapped Ether"],
    ["SPACE", "Nounspace"],
    ["DEGEN", "Degen"],
    ["cbBTC", "Coinbase Wrapped BTC"],
  ])("leaves %s alone", (symbol, name) => {
    expect(hasSpamLabel(symbol, name)).toBe(false);
  });
});
