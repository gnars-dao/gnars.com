import { describe, expect, it } from "vitest";
import {
  isNftInsightIdentity,
  marketplaceActivitySchema,
  mergeNftActivity,
  type MarketplaceActivityEvent,
} from "./nft-insights";

const event: MarketplaceActivityEvent = {
  id: "transfer",
  type: "transfer",
  transactionHash: `0x${"aa".repeat(32)}`,
  timestamp: 1800000000,
  from: `0x${"11".repeat(20)}`,
  to: `0x${"22".repeat(20)}`,
};
describe("NFT insights", () => {
  it("prefers native sales regardless of provider page order", () => {
    const native = {
      ...event,
      id: "native:1",
      type: "sale" as const,
      source: "gnars-contract" as const,
    };
    const provider = { ...native, id: "provider", source: "opensea" as const };
    expect(mergeNftActivity([provider, event, native])).toEqual([native]);
    expect(mergeNftActivity([native, event, provider])).toEqual([native]);
  });
  it("preserves separate native fills in one transaction and unrelated transfers", () => {
    const native = {
      ...event,
      id: "native:1",
      type: "sale" as const,
      source: "gnars-contract" as const,
    };
    const second = { ...native, id: "native:2" };
    const other = { ...event, id: "other", from: `0x${"33".repeat(20)}` };
    expect(
      mergeNftActivity([
        native,
        second,
        event,
        other,
        { ...native, id: "provider", source: "opensea" },
      ]),
    ).toEqual([native, second, other]);
  });
  it("accepts combined source availability and canonical coverage", () => {
    const page = {
      collectionAddress: event.from,
      tokenId: "1",
      source: "combined",
      nextCursor: null,
      events: [],
      sources: { gnars: { available: true }, opensea: { available: false } },
      coverage: { startBlock: "1", indexedThrough: "42", blockHash: event.transactionHash },
    };
    expect(marketplaceActivitySchema.parse(page)).toEqual(page);
    expect(
      marketplaceActivitySchema.safeParse({
        ...page,
        coverage: { ...page.coverage, blockHash: "invalid" },
      }).success,
    ).toBe(false);
  });
  it("requires both collection and token identity", () => {
    const result = { collectionAddress: `0x${"ab".repeat(20)}`, tokenId: "1" };
    expect(isNftInsightIdentity(result, result.collectionAddress.toUpperCase(), "01")).toBe(true);
    expect(isNftInsightIdentity(result, result.collectionAddress, "2")).toBe(false);
    expect(isNftInsightIdentity(result, `0x${"cd".repeat(20)}`, "1")).toBe(false);
  });
  it("suppresses a matching transfer only when its sale is actually available", () => {
    expect(mergeNftActivity([event, event])).toEqual([event]);
    const sale = { ...event, id: "sale", type: "sale" as const };
    expect(mergeNftActivity([event, sale])).toEqual([sale]);
    const otherRecipient = { ...event, id: "other", to: `0x${"33".repeat(20)}` };
    expect(mergeNftActivity([event, sale, otherRecipient])).toEqual([sale, otherRecipient]);
  });
  it("keeps mint/burn distinct and orders across pages by time", () => {
    const mint = { ...event, id: "mint", type: "mint" as const, timestamp: event.timestamp - 100 };
    const burn = { ...event, id: "burn", type: "burn" as const, timestamp: event.timestamp + 100 };
    expect(mergeNftActivity([mint, event, burn]).map((row) => row.type)).toEqual([
      "burn",
      "transfer",
      "mint",
    ]);
  });
  it("keeps payment amounts exact and rejects unsafe activity documents", () => {
    const payment = {
      quantity: "1300000000000000",
      decimals: 18,
      symbol: "WETH",
      tokenAddress: `0x${"44".repeat(20)}`,
    };
    const page = {
      collectionAddress: event.from,
      tokenId: "1",
      source: "opensea",
      nextCursor: null,
      events: [{ ...event, payment }],
    };
    expect(marketplaceActivitySchema.parse(page).events[0].payment).toEqual(payment);
    expect(() =>
      marketplaceActivitySchema.parse({
        ...page,
        events: [{ ...event, payment: { ...payment, quantity: 1300000000000000 } }],
      }),
    ).toThrow();
    expect(() =>
      marketplaceActivitySchema.parse({
        ...page,
        events: [{ ...event, transactionHash: "javascript:alert(1)" }],
      }),
    ).toThrow();
    expect(() =>
      marketplaceActivitySchema.parse({
        ...page,
        events: [{ ...event, payment: { ...payment, decimals: 999 } }],
      }),
    ).toThrow();
  });
});
