import { describe, expect, it } from "vitest";
import type { FarcasterLookup } from "./farcaster";
import { buildFarcasterSliceReport, deriveFarcasterSliceState } from "./farcaster-tv-aggregator";

/**
 * The /tv half of issue #2.
 *
 * On /members the lie was about named people and somebody would eventually
 * squint at it. Here it was a `0` inside an aggregate that adds up — the feed
 * still returned 407 items from other sources, so nothing looked wrong, and an
 * aggregate that adds up is precisely what nobody audits. These pin the rule
 * that stops a failed read from being counted as "nobody holds anything".
 */

const found = (fid: number): FarcasterLookup => ({
  status: "found",
  profile: {
    fid,
    username: `u${fid}`,
    displayName: null,
    pfpUrl: null,
    followerCount: 0,
    followingCount: 0,
    bio: null,
  },
});
const absent = (): FarcasterLookup => ({ status: "absent" });
const unavailable = (reason = "Neynar rejected the API key (HTTP 401)"): FarcasterLookup => ({
  status: "unavailable",
  reason,
});

describe("deriveFarcasterSliceState", () => {
  it("ok when every lookup answered with a profile", () => {
    expect(deriveFarcasterSliceState([found(1), found(2)])).toEqual({ status: "ok" });
  });

  it("ok when every lookup answered and the answer was nobody", () => {
    // A real zero. Nobody in this set has a Farcaster account, and we know it
    // because we asked. This one is allowed to be reported as zero.
    expect(deriveFarcasterSliceState([absent(), absent()])).toEqual({ status: "ok" });
  });

  it("unavailable when nothing could be read — the production failure", () => {
    const state = deriveFarcasterSliceState([unavailable(), unavailable()]);
    expect(state.status).toBe("unavailable");
    expect((state as { reason: string }).reason).toMatch(/key/i);
  });

  it("incomplete when only some could be read, and says how many were lost", () => {
    // The most dangerous case: the counts are non-zero, so the payload looks
    // healthier than the previous case while still being a lower bound.
    const state = deriveFarcasterSliceState([found(1), unavailable(), absent()]);
    expect(state.status).toBe("incomplete");
    expect((state as { unresolvedWallets: number }).unresolvedWallets).toBe(1);
  });

  it("never reports ok when any lookup failed", () => {
    // The regression in one line.
    expect(deriveFarcasterSliceState([found(1), found(2), unavailable()]).status).not.toBe("ok");
    expect(deriveFarcasterSliceState([absent(), unavailable()]).status).not.toBe("ok");
    expect(deriveFarcasterSliceState([unavailable()]).status).not.toBe("ok");
  });

  it("does not confuse 'no wallets to check' with 'reads failed'", () => {
    // Nothing was asked because there was nothing to ask about. That is not a
    // failure, and calling it one would cry wolf on every empty creator set.
    expect(deriveFarcasterSliceState([])).toEqual({ status: "ok" });
  });

  it("carries a reason even when the lookup supplied an empty one", () => {
    const state = deriveFarcasterSliceState([unavailable("")]);
    expect((state as { reason: string }).reason).toBeTruthy();
  });

  it("reports the first failure's reason, not a generic one", () => {
    const state = deriveFarcasterSliceState([unavailable("socket hang up"), found(1)]);
    expect((state as { reason: string }).reason).toBe("socket hang up");
  });
});

describe("buildFarcasterSliceReport — a failed read has no number to quote", () => {
  const counts = { items: 12, creators: 3, coins: 9, nfts: 0 };

  it("ok: the counts are present and unqualified", () => {
    const report = buildFarcasterSliceReport({ status: "ok" }, counts);
    expect(report).toEqual({ status: "ok", items: 12, creators: 3, coins: 9, nfts: 0 });
  });

  it("unavailable: there is NO count field at all", () => {
    // This is the whole point. `report.coins ?? 0` cannot be written, because
    // `coins` does not exist on this branch — there is nothing to default.
    const report = buildFarcasterSliceReport({ status: "unavailable", reason: "key" }, counts);
    expect(report).toEqual({ status: "unavailable", reason: "key" });
    expect(Object.keys(report)).not.toContain("coins");
    expect(Object.keys(report)).not.toContain("items");
    expect(Object.keys(report)).not.toContain("creators");
    expect(Object.keys(report)).not.toContain("nfts");
  });

  it("unavailable: the counts are dropped even when they are non-zero", () => {
    // A partial fetch that then failed must not leak its partial numbers as
    // though they were an answer.
    const report = buildFarcasterSliceReport(
      { status: "unavailable", reason: "socket hang up" },
      { items: 99, creators: 99, coins: 99, nfts: 99 },
    );
    expect(JSON.stringify(report)).not.toContain("99");
  });

  it("incomplete: counts are present but named as a lower bound", () => {
    const report = buildFarcasterSliceReport(
      { status: "incomplete", reason: "key", unresolvedWallets: 2 },
      counts,
    );
    // No bare `coins`/`items` that could be quoted as a total.
    expect(Object.keys(report)).not.toContain("coins");
    expect(Object.keys(report)).not.toContain("items");
    expect(report).toMatchObject({
      status: "incomplete",
      unresolvedWallets: 2,
      itemsSoFar: 12,
      coinsSoFar: 9,
    });
  });

  it("a real zero still renders as a zero", () => {
    // The legitimate case must survive: we asked, nobody holds anything.
    const report = buildFarcasterSliceReport(
      { status: "ok" },
      { items: 0, creators: 0, coins: 0, nfts: 0 },
    );
    expect(report).toEqual({ status: "ok", items: 0, creators: 0, coins: 0, nfts: 0 });
  });
});
