import { describe, expect, it } from "vitest";
import {
  buildQuoteUrl,
  NATIVE_SENTINEL,
  toSwapProToken,
  toWidgetError,
  toWidgetQuote,
  SWAPPRO_CHAINS,
  type SwapProQuote,
} from "./swappro";

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TAKER = "0x21c9a94AF76B59b171b32fD125A4edF0e9A2Ad3e";

// Captured from https://www.swaps.pro/api/sdk/v1/quote on 2026-09-03 (calldata shortened).
const QUOTE: SwapProQuote = {
  provider: "0x",
  sellChain: "BASE",
  buyChain: "BASE",
  sellToken: { caip: "eip155:8453/slip44:60", symbol: "ETH" },
  buyToken: { caip: `eip155:8453/erc20:${USDC}`, symbol: "USDC" },
  sellAmount: "0.1",
  buyAmount: "246.927321",
  minBuyAmount: "244.458047",
  rate: 2469.27321,
  tx: {
    chainId: 8453,
    to: "0x0000000000001ff3684f28c67538d4d072c22734",
    data: "0x2213bc0b000000000000000000000000",
    value: "0x16345785d8a0000",
    gasLimit: "0x2f8d0",
  },
  expiresAt: "2026-09-03T12:00:00.000Z",
  partner: "gnars",
  partnerFee: {
    requestedBps: 0,
    collectedBps: 0,
    collected: false,
    note: "No partner fee was requested.",
  },
};

describe("token mapping", () => {
  it("sends the native sentinel as the chain's native symbol and addresses as themselves", () => {
    expect(toSwapProToken(8453, NATIVE_SENTINEL)).toBe("ETH");
    expect(toSwapProToken(8453, NATIVE_SENTINEL.toUpperCase().replace("0X", "0x"))).toBe("ETH");
    expect(toSwapProToken(8453, USDC)).toBe(USDC);
    expect(toSwapProToken(10, USDC)).toBeNull();
  });
});

describe("quote URL", () => {
  it("converts base units to human decimals and carries the affiliate fee as partner + bps", () => {
    const url = buildQuoteUrl({
      chainId: 8453,
      sellToken: NATIVE_SENTINEL,
      buyToken: USDC,
      sellAmount: "100000000000000000",
      sellDecimals: 18,
      buyDecimals: 6,
      taker: TAKER,
      fee: { recipient: "0x1111111111111111111111111111111111111111", bps: 50 },
    });
    expect(url).toContain("sellChain=8453");
    expect(url).toContain("sellToken=ETH");
    expect(url).toContain(`buyToken=${USDC}`);
    expect(url).toContain("amount=0.1");
    expect(url).toContain(`address=${TAKER}`);
    expect(url).toContain("partner=0x1111111111111111111111111111111111111111");
    expect(url).toContain("partnerFeeBps=50");
  });

  it("names gnars as the partner without a fee, and refuses a chain SwapsPro does not route", () => {
    const base = {
      sellToken: NATIVE_SENTINEL,
      buyToken: USDC,
      sellAmount: "1",
      sellDecimals: 18,
      buyDecimals: 6,
      taker: TAKER,
    };
    expect(buildQuoteUrl({ chainId: 8453, ...base })).toContain("partner=gnars");
    expect(buildQuoteUrl({ chainId: 8453, ...base })).not.toContain("partnerFeeBps");
    expect(buildQuoteUrl({ chainId: 10, ...base })).toBeNull();
  });
});

describe("widget shape", () => {
  it("returns base units, the enforced floor, the transaction, and the venue", () => {
    const w = toWidgetQuote(QUOTE, 18, 6);
    expect(w.liquidityAvailable).toBe(true);
    expect(w.sellAmount).toBe("100000000000000000");
    expect(w.buyAmount).toBe("246927321");
    expect(w.minBuyAmount).toBe("244458047");
    expect(w.transaction).toEqual({
      to: "0x0000000000001ff3684f28c67538d4d072c22734",
      data: "0x2213bc0b000000000000000000000000",
      value: "100000000000000000",
      gas: "194768",
    });
    expect(w.route).toBe("0x");
    expect(w.issues?.allowance).toBeNull();
  });

  it("surfaces an exact-amount approval as issues.allowance so the Approve button appears", () => {
    const w = toWidgetQuote(
      {
        ...QUOTE,
        approval: {
          chainId: 8453,
          token: USDC,
          spender: "0x0000000000001ff3684f28c67538d4d072c22734",
          amountWei: "100000000",
        },
      },
      6,
      18,
    );
    expect(w.issues?.allowance).toEqual({
      spender: "0x0000000000001ff3684f28c67538d4d072c22734",
      amount: "100000000",
    });
  });

  it("turns a SwapsPro error into a no-liquidity answer with the reason", () => {
    const w = toWidgetError({ error: "No route for this pair at this size", code: "NO_ROUTE" });
    expect(w.liquidityAvailable).toBe(false);
    expect(w.reason).toContain("No route");
    expect(w.transaction).toBeUndefined();
  });
});

describe("error shapes", () => {
  it("reads the v1 string error", () => {
    const w = toWidgetError({ error: "No route for this pair", code: "NO_ROUTE" });
    expect(w.liquidityAvailable).toBe(false);
    expect(w.reason).toBe("No route for this pair");
    expect(w.code).toBe("NO_ROUTE");
  });

  it("reads the standard object error without printing [object Object]", () => {
    const w = toWidgetError({
      error: { code: "INSUFFICIENT_LIQUIDITY", message: "Not enough liquidity", retryable: true },
      message: "Not enough liquidity",
    });
    expect(w.reason).toBe("Not enough liquidity");
    expect(w.code).toBe("INSUFFICIENT_LIQUIDITY");
    expect(w.reason).not.toContain("object Object");
  });

  it("falls back to the transitional top-level message when the object carries none", () => {
    const w = toWidgetError({ error: { code: "RATE_LIMITED" }, message: "Too many requests" });
    expect(w.reason).toBe("Too many requests");
    expect(w.code).toBe("RATE_LIMITED");
  });

  it("never leaves the widget without a sentence", () => {
    const w = toWidgetError({ error: { retryable: false } });
    expect(w.reason).toBeTruthy();
    expect(w.code).toBe("UPSTREAM_UNAVAILABLE");
  });
});

describe("every SwapsPro chain builds a quote URL", () => {
  it("routes the six EVM chains and refuses the rest", () => {
    for (const chainId of Object.keys(SWAPPRO_CHAINS).map(Number)) {
      const url = buildQuoteUrl({
        chainId,
        sellToken: NATIVE_SENTINEL,
        buyToken: "0x0000000000000000000000000000000000000001",
        sellAmount: "1000000000000000000",
        sellDecimals: 18,
        buyDecimals: 18,
        taker: "0x21c9a94AF76B59b171b32fD125A4edF0e9A2Ad3e",
      });
      expect(url, `chain ${chainId}`).toContain(`sellChain=${chainId}`);
      // The native asset goes by the symbol SwapsPro resolves, never the 0x sentinel.
      expect(url).toContain(`sellToken=${SWAPPRO_CHAINS[chainId].native}`);
      expect(url).not.toContain(NATIVE_SENTINEL);
    }
    expect(
      buildQuoteUrl({
        chainId: 10,
        sellToken: NATIVE_SENTINEL,
        buyToken: "0x0000000000000000000000000000000000000001",
        sellAmount: "1",
        sellDecimals: 18,
        buyDecimals: 18,
        taker: "0x21c9a94AF76B59b171b32fD125A4edF0e9A2Ad3e",
      }),
    ).toBeNull();
  });
});
