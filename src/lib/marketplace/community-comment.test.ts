import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { walletPayloadDigest } from "@/lib/wallet-authorization";
import {
  communityCommentPayload,
  communityListingCommentSchema,
  communityPublicationSchema,
} from "./community-comment";

const protocol = "0x3333333333333333333333333333333333333333";
const hash = `0x${"a".repeat(64)}` as const;
beforeEach(() => vi.stubEnv("NEXT_PUBLIC_GNARS_MARKETPLACE_ADDRESS", protocol));
afterEach(() => vi.unstubAllEnvs());
describe("community seller comment", () => {
  it("normalizes plain text while preserving newlines and not interpreting HTML", () => {
    expect(communityListingCommentSchema.parse("  My NFT\n<b>literal text</b>  ")).toBe(
      "My NFT\n<b>literal text</b>",
    );
    expect(communityListingCommentSchema.parse("x".repeat(280))).toHaveLength(280);
    expect(communityListingCommentSchema.safeParse("x".repeat(281)).success).toBe(false);
  });
  it("uses the same UTF-16 limit as the textarea and rejects unsafe control characters", () => {
    expect(communityListingCommentSchema.safeParse("\u{1f600}".repeat(140)).success).toBe(true);
    expect(communityListingCommentSchema.safeParse("\u{1f600}".repeat(141)).success).toBe(false);
    expect(communityListingCommentSchema.safeParse("hello\u0000world").success).toBe(false);
  });
  it("keeps the field optional and rejects orphan authorization or unexpected policy fields", () => {
    expect(communityPublicationSchema.parse({})).toEqual({});
    expect(communityPublicationSchema.safeParse({ authorization: {} }).success).toBe(false);
    expect(
      communityPublicationSchema.safeParse({ listingComment: "", authorization: {} }).success,
    ).toBe(false);
    expect(
      communityPublicationSchema.safeParse({ listingComment: "text", feePolicy: {} }).success,
    ).toBe(false);
  });
  it("binds normalized comment to the chain, native protocol and exact order hash", () => {
    const payload = communityCommentPayload(hash, " Story ");
    expect(payload).toEqual({
      chainId: 8453,
      protocolAddress: protocol,
      orderHash: hash,
      listingComment: "Story",
    });
    const digest = walletPayloadDigest(payload);
    expect(walletPayloadDigest(communityCommentPayload(hash, "Changed"))).not.toBe(digest);
    expect(walletPayloadDigest(communityCommentPayload(`0x${"b".repeat(64)}`, "Story"))).not.toBe(
      digest,
    );
    expect(walletPayloadDigest({ ...payload, chainId: 1 })).not.toBe(digest);
    expect(walletPayloadDigest({ ...payload, protocolAddress: `0x${"1".repeat(40)}` })).not.toBe(
      digest,
    );
  });
});
