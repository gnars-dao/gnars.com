import { describe, expect, it } from "vitest";
import { DAO_ADDRESSES } from "@/lib/config";
import { buildMarketplaceShareUrl, parseMarketplaceShareQuery } from "./share";

describe("marketplace miniapp share identity", () => {
  it("preserves exact order, collection and locale on the associated domain", () => {
    const url = new URL(
      buildMarketplaceShareUrl({
        tokenId: "00054",
        collectionAddress: "0x9580c826076bcba116ce4729ec243290c2e3b441",
        source: "gnars-contract",
        orderHash: `0x${"AB".repeat(32)}`,
        locale: "pt-br",
      }),
    );
    expect(url.origin).toBe("https://gnars.com");
    expect(url.pathname).toBe("/pt-br/marketplace");
    expect(url.searchParams.get("nft")).toBe("54");
    expect(url.searchParams.get("order")).toBe(`0x${"ab".repeat(32)}`);
    expect(url.searchParams.get("collection")).toBe("0x9580c826076bcba116ce4729ec243290c2e3b441");
  });
  it("normalizes native Gnars and ignores arbitrary URL/text inputs", () => {
    expect(
      parseMarketplaceShareQuery({
        nft: "42",
        collection: DAO_ADDRESSES.token,
        image: "http://localhost",
        price: "1",
        url: "https://evil.test",
      }),
    ).toEqual({ tokenId: "42" });
    expect(buildMarketplaceShareUrl({ tokenId: "42" })).toBe(
      "https://gnars.com/marketplace?nft=42",
    );
  });
  for (const query of [
    { nft: ["42", "43"] },
    { nft: "-1" },
    { nft: "1e3" },
    { nft: (2n ** 256n).toString() },
    { nft: "42", collection: "http://localhost" },
    { nft: "42", order: "0x123", source: "gnars" },
    { nft: "42", source: "gnars" },
    { nft: "42", order: `0x${"1".repeat(64)}` },
    { nft: "42", order: `0x${"1".repeat(64)}`, source: ["gnars"] },
  ])
    it(`rejects ambiguous or invalid share query ${JSON.stringify(query)}`, () => {
      expect(parseMarketplaceShareQuery(query)).toBeNull();
    });
});
