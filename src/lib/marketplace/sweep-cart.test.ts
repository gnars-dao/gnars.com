import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MixedSweepPlan } from "./mixed-sweep";
import { SEAPORT_ADDRESS } from "./routing";
import { applySweepConfirmation, parseSweepCart, type SweepCart } from "./sweep-cart";

const buyer = "0x2222222222222222222222222222222222222222";
const seller = "0x1111111111111111111111111111111111111111";
const protocol = "0xC35813d40961151c11C97cB9d67D0D25CD4Cc86e";
const hash = (id: number) => `0x${String(id).padStart(64, "0")}` as `0x${string}`;
function plan(nativeOnly = false): MixedSweepPlan {
  const expiresAt = Math.floor(Date.now() / 1000) + 90;
  return {
    buyer,
    totalWei: "3000",
    expiresAt,
    items: [1, 2].map((id) => ({
      tokenId: String(id),
      name: `Gnar #${id}`,
      image: null,
      owner: seller,
      offers: [
        {
          id: `offer-${id}`,
          source: id === 1 || nativeOnly ? "gnars-contract" : "opensea",
          protocolAddress: id === 1 || nativeOnly ? protocol : SEAPORT_ADDRESS,
          seller,
          orderHash: hash(id),
          priceWei: String(id * 1000),
          currency: "ETH",
          expiresAt: expiresAt + 100,
        },
      ],
    })),
  };
}
function cart(nativeOnly = false): SweepCart {
  return {
    plan: plan(nativeOnly),
    purchased: [],
    skipped: [],
    awaiting: nativeOnly ? "batch" : "1",
    previousJournalId: "previous",
  };
}
const confirmed = () => ({
  journalId: "new",
  tokenId: "1",
  source: "gnars-contract",
  orderHash: hash(1),
});
beforeEach(() => vi.stubEnv("NEXT_PUBLIC_GNARS_MARKETPLACE_ADDRESS", protocol));
afterEach(() => vi.unstubAllEnvs());

describe("durable combined sweep cart", () => {
  it("roundtrips exact selections and progress without dropping prices", () => {
    const saved = { ...cart(), purchased: ["1"], awaiting: "2" };
    expect(parseSweepCart(JSON.stringify(saved), buyer)).toEqual(saved);
  });
  it("restores expired carts for explicit review, including already settled old offers", () => {
    const saved = { ...cart(), purchased: ["1"], awaiting: "2" };
    saved.plan.expiresAt = Math.floor(Date.now() / 1000) - 10;
    saved.plan.items[0].offers[0].expiresAt = saved.plan.expiresAt - 100;
    expect(parseSweepCart(JSON.stringify(saved), buyer).purchased).toEqual(["1"]);
    saved.plan.expiresAt = Math.floor(Date.now() / 1000) + 90;
    expect(parseSweepCart(JSON.stringify(saved), buyer).plan.totalWei).toBe("3000");
  });
  it("rejects wrong wallets, altered totals and foreign progress IDs", () => {
    expect(() => parseSweepCart(JSON.stringify(cart()), seller)).toThrow();
    const altered = cart();
    altered.plan.totalWei = "1";
    expect(() => parseSweepCart(JSON.stringify(altered), buyer)).toThrow();
    for (const replacement of [
      { purchased: ["3"] },
      { skipped: ["3"] },
      { purchased: ["1", "1"] },
      { purchased: ["1"], skipped: ["1"] },
      { awaiting: "3" },
      { previousJournalId: 1 },
      { skipped: null },
    ])
      expect(() => parseSweepCart(JSON.stringify({ ...cart(), ...replacement }), buyer)).toThrow();
  });
  it("rejects altered contract routing and duplicate assets", () => {
    const wrongProtocol = cart();
    wrongProtocol.plan.items[0].offers[0].protocolAddress = SEAPORT_ADDRESS;
    expect(() => parseSweepCart(JSON.stringify(wrongProtocol), buyer)).toThrow();
    const duplicate = cart();
    duplicate.plan.items[1].tokenId = "1";
    expect(() => parseSweepCart(JSON.stringify(duplicate), buyer)).toThrow();
  });
  it("advances exactly the confirmed item and remains idempotent", () => {
    const saved = cart();
    const next = applySweepConfirmation(saved, confirmed());
    expect(next.purchased).toEqual(["1"]);
    expect(next.awaiting).toBeUndefined();
    expect(saved.purchased).toEqual([]);
    expect(applySweepConfirmation(next, confirmed())).toBe(next);
    const resumed = { ...next, awaiting: "2", previousJournalId: "new" };
    const finished = applySweepConfirmation(resumed, {
      journalId: "next",
      tokenId: "2",
      source: "opensea",
      orderHash: hash(2),
    });
    expect(finished.purchased).toEqual(["1", "2"]);
    expect(finished.plan.totalWei).toBe("3000");
  });
  it.each([
    { journalId: "previous" },
    { tokenId: "2" },
    { source: "opensea" },
    { orderHash: hash(3) },
    { orderHash: undefined },
    { result: { purchasedTokenIds: ["1"], skippedTokenIds: [] } },
  ])("ignores a stale or mismatched single-item confirmation %j", (replacement) => {
    const saved = cart();
    expect(applySweepConfirmation(saved, { ...confirmed(), ...replacement })).toBe(saved);
  });
  it("accepts case-insensitive order hashes without allowing another order", () => {
    const saved = cart();
    saved.plan.items[0].offers[0].orderHash = `0x${"a".repeat(64)}`;
    expect(
      applySweepConfirmation(saved, { ...confirmed(), orderHash: `0x${"A".repeat(64)}` }).purchased,
    ).toEqual(["1"]);
  });
  it("records complete native batch results only for the exact ordered hashes", () => {
    const saved = cart(true);
    const confirmation = {
      ...confirmed(),
      sweepOrderHashes: [hash(1), hash(2)],
      result: { purchasedTokenIds: ["1"], skippedTokenIds: ["2"] },
    };
    const next = applySweepConfirmation(saved, confirmation);
    expect(next).toMatchObject({ purchased: ["1"], skipped: ["2"], awaiting: undefined });
    expect(applySweepConfirmation(next, confirmation)).toBe(next);
  });
  it("rejects a batch confirmation from another request, source or order set", () => {
    const saved = cart(true);
    const confirmation = {
      ...confirmed(),
      sweepOrderHashes: [hash(1), hash(2)],
      result: { purchasedTokenIds: ["1"], skippedTokenIds: ["2"] },
    };
    for (const replacement of [
      { journalId: "previous" },
      { source: "opensea" },
      { sweepOrderHashes: undefined },
      { sweepOrderHashes: [hash(2), hash(1)] },
      { sweepOrderHashes: [hash(1), hash(3)] },
      { sweepOrderHashes: [hash(1)] },
      { result: null },
      { result: { purchasedTokenIds: ["1"], skippedTokenIds: [] } },
      { result: { purchasedTokenIds: ["1", "1"], skippedTokenIds: [] } },
      { result: { purchasedTokenIds: ["1"], skippedTokenIds: ["3"] } },
    ])
      expect(applySweepConfirmation(saved, { ...confirmation, ...replacement })).toBe(saved);
    const mixed = { ...cart(), awaiting: "batch" };
    expect(applySweepConfirmation(mixed, confirmation)).toBe(mixed);
  });
});
