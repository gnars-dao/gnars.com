import { describe, expect, it } from "vitest";
import { DAO_ADDRESSES } from "./config";
import { allowedReceiptTags, filterReceiptTags } from "./revalidation-policy";

describe("receipt-scoped cache invalidation", () => {
  it("rejects arbitrary transfers and unknown contracts", () => {
    expect(filterReceiptTags(["stake", "feed"], allowedReceiptTags(8453, ["0x123"]))).toEqual([]);
  });
  it("does not allow an auction receipt to invalidate stake or proposals", () => {
    expect(
      filterReceiptTags(
        ["auction", "stake", "proposal:12"],
        allowedReceiptTags(8453, [DAO_ADDRESSES.auction]),
      ),
    ).toEqual(["auction"]);
  });
  it("scopes governance receipts and removes duplicate tags", () => {
    expect(
      filterReceiptTags(
        ["proposals", "proposals", "proposal:12", "round:test"],
        allowedReceiptTags(8453, [DAO_ADDRESSES.governor]),
      ),
    ).toEqual(["proposals", "proposal:12"]);
  });
  it("does not trust Base contract addresses on another chain", () => {
    expect(allowedReceiptTags(1, [DAO_ADDRESSES.governor]).size).toBe(0);
  });
});
