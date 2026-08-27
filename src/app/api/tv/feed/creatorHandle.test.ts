import { describe, expect, it } from "vitest";
import { buildCreatorContentReport, isUsableCreatorHandle } from "./route";

/**
 * Truncated-address "handles" — the noise half of the 27/08 feed collapse.
 *
 * Zora returns `0x9a67...91fd` as a profile's handle when it has no name. That
 * is display text, not an identifier: passing it to getProfileCoins always
 * resolves to a null profile. Three of the eleven qualified creators that day
 * were exactly this, and each one burned a request to learn nothing.
 *
 * They are SKIPPED, not counted as failures — nothing broke, there was simply
 * nothing askable — which is why the distinction is pinned here.
 */
describe("isUsableCreatorHandle", () => {
  it("rejects Zora's truncated-address display form", () => {
    // The three real ones from the 27/08 payload.
    expect(isUsableCreatorHandle("0x9a67...91fd")).toBe(false);
    expect(isUsableCreatorHandle("0x72ad...6f88")).toBe(false);
    expect(isUsableCreatorHandle("0x4a0a...9eb3")).toBe(false);
  });

  it("accepts real handles, including ENS and 0x-prefixed names", () => {
    expect(isUsableCreatorHandle("skatehacker")).toBe(true);
    expect(isUsableCreatorHandle("nogenta")).toBe(true);
    expect(isUsableCreatorHandle("kevinlangeree.eth")).toBe(true);
    // A name that merely STARTS with 0x is a real handle and must survive —
    // this one was in the same list and does resolve.
    expect(isUsableCreatorHandle("0xsatori.eth")).toBe(true);
  });

  it("does not reject a full address", () => {
    // Not the pattern we are filtering, and it may well resolve.
    expect(isUsableCreatorHandle("0x9a670ea90b3683ca6d90572b4f5cdbdd0000091fd")).toBe(true);
  });

  it("rejects empty and missing handles", () => {
    expect(isUsableCreatorHandle("")).toBe(false);
    expect(isUsableCreatorHandle("   ")).toBe(false);
    expect(isUsableCreatorHandle(null)).toBe(false);
    expect(isUsableCreatorHandle(undefined)).toBe(false);
  });

  it("is case-insensitive on the hex, since Zora mixes case", () => {
    expect(isUsableCreatorHandle("0x9A67...91FD")).toBe(false);
  });
});

describe("buildCreatorContentReport — the catch that counts", () => {
  it("ok when nothing failed, and reports the real item count", () => {
    expect(
      buildCreatorContentReport({
        items: 375,
        creatorsAsked: 19,
        creatorsSkipped: 0,
        creatorsFailed: 0,
      }),
    ).toEqual({ status: "ok", items: 375, creatorsAsked: 19, creatorsSkipped: 0 });
  });

  it("ok with zero items is allowed — asked everyone, nobody had coins", () => {
    // The legitimate zero. It must stay reportable, or the fix becomes an
    // alarm that cries wolf on a quiet day.
    expect(
      buildCreatorContentReport({
        items: 0,
        creatorsAsked: 3,
        creatorsSkipped: 0,
        creatorsFailed: 0,
      }),
    ).toMatchObject({ status: "ok", items: 0 });
  });

  it("unavailable when every creator asked failed — the 27/08 shape", () => {
    const r = buildCreatorContentReport({
      items: 0,
      creatorsAsked: 8,
      creatorsSkipped: 3,
      creatorsFailed: 8,
      reason: "fetch failed",
    });
    expect(r.status).toBe("unavailable");
    // No item count on this branch: zero items from zero successful reads is
    // not a measurement, and offering the number invites quoting it.
    expect(Object.keys(r)).not.toContain("items");
    expect(Object.keys(r)).not.toContain("itemsSoFar");
  });

  it("incomplete when only some failed, and names the count", () => {
    const r = buildCreatorContentReport({
      items: 40,
      creatorsAsked: 8,
      creatorsSkipped: 1,
      creatorsFailed: 2,
    });
    expect(r).toMatchObject({ status: "incomplete", itemsSoFar: 40, creatorsFailed: 2 });
    expect(Object.keys(r)).not.toContain("items");
  });

  it("skipped handles are not failures", () => {
    // Three unusable handles and every real one answered is a healthy pass.
    const r = buildCreatorContentReport({
      items: 12,
      creatorsAsked: 8,
      creatorsSkipped: 3,
      creatorsFailed: 0,
    });
    expect(r.status).toBe("ok");
    expect(r).toMatchObject({ creatorsSkipped: 3 });
  });

  it("never reports ok when anything failed", () => {
    for (const failed of [1, 5, 8]) {
      expect(
        buildCreatorContentReport({
          items: 1,
          creatorsAsked: 8,
          creatorsSkipped: 0,
          creatorsFailed: failed,
        }).status,
      ).not.toBe("ok");
    }
  });

  it("always carries a reason on a failure branch", () => {
    const r = buildCreatorContentReport({
      items: 0,
      creatorsAsked: 2,
      creatorsSkipped: 0,
      creatorsFailed: 2,
      reason: "",
    });
    expect((r as { reason: string }).reason).toBeTruthy();
  });
});
