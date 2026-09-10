import { describe, expect, it } from "vitest";
import type { MarketplaceOffer } from "@/types/marketplace";
import { commentRevision, readCommentOffer, updateCachedComment } from "./comment-editor-state";

const offer: MarketplaceOffer = {
  id: "community-test",
  source: "gnars-contract",
  orderHash: `0x${"1".repeat(64)}`,
  protocolAddress: `0x${"2".repeat(40)}`,
  collectionAddress: `0x${"3".repeat(40)}`,
  seller: `0x${"4".repeat(40)}`,
  priceWei: "10000000000000000",
  currency: "ETH",
  expiresAt: 1800000000,
  listingComment: "Original comment",
};

describe("comment editor state", () => {
  it("treats legacy comments as revision zero", () => {
    expect(commentRevision(offer)).toBe(0);
  });

  it("accepts authoritative edits and removal without changing trade terms", () => {
    const edited = readCommentOffer(
      { offer: { ...offer, listingComment: "Updated", listingCommentRevision: 1, priceWei: "99" } },
      offer,
    );
    expect(edited.listingComment).toBe("Updated");
    expect(edited.listingCommentRevision).toBe(1);
    expect(edited.priceWei).toBe(offer.priceWei);
    const removed = readCommentOffer(
      { offer: { ...offer, listingComment: undefined, listingCommentRevision: 2 } },
      edited,
    );
    expect(removed.listingComment).toBeUndefined();
  });

  it.each([
    { orderHash: `0x${"9".repeat(64)}` },
    { protocolAddress: `0x${"9".repeat(40)}` },
    { seller: `0x${"9".repeat(40)}` },
    { collectionAddress: `0x${"9".repeat(40)}` },
    { source: "opensea" },
    { listingCommentRevision: -1 },
    { listingCommentRevision: 0.5 },
    { listingCommentRevision: undefined },
    { listingComment: "x".repeat(281) },
    { listingComment: {} },
  ])("rejects wrong identity or malformed response %o", (changes) => {
    expect(() =>
      readCommentOffer({ offer: { ...offer, listingCommentRevision: 1, ...changes } }, offer),
    ).toThrow("Invalid comment response");
  });

  it("rejects revision rollback after conflict recovery", () => {
    expect(() =>
      readCommentOffer(
        { offer: { ...offer, listingCommentRevision: 1 } },
        { ...offer, listingCommentRevision: 2 },
      ),
    ).toThrow();
  });

  it("updates pages and infinite pages, preserves other orders and page metadata", () => {
    const other = { ...offer, orderHash: `0x${"5".repeat(64)}` };
    const data = {
      pages: [{ items: [{ tokenId: "42", offers: [offer, other] }], nextCursor: "next" }],
      pageParams: [null],
    };
    const next = { ...offer, listingComment: "New", listingCommentRevision: 1 };
    expect(updateCachedComment(data, next)).toEqual({
      ...data,
      pages: [{ ...data.pages[0], items: [{ tokenId: "42", offers: [next, other] }] }],
    });
    expect(data.pages[0].items[0].offers[0].listingComment).toBe("Original comment");
  });

  it("does not overwrite newer cached comments or same hash on another protocol", () => {
    const newer = { ...offer, listingComment: "Latest", listingCommentRevision: 3 };
    const otherProtocol = { ...offer, protocolAddress: `0x${"5".repeat(40)}` };
    const page = { items: [{ offers: [newer, otherProtocol] }] };
    expect(updateCachedComment(page, { ...offer, listingCommentRevision: 2 })).toEqual(page);
  });

  it("leaves unrelated marketplace query data intact", () => {
    const eligibility = { eligible: true, gnarsBalance: "6" };
    expect(updateCachedComment(undefined, offer)).toBeUndefined();
    expect(updateCachedComment(eligibility, offer)).toBe(eligibility);
  });
});
