import { describe, expect, it } from "vitest";
import { browseIdentity, decodeBrowseCursor, encodeBrowseCursor } from "./marketplace-pagination";

describe("marketplace bounded cursors", () => {
  it("rejects forged ids that cannot fit a PostgreSQL bigint", () => {
    const identity = browseIdentity({ sort: "price-asc" });
    const raw = encodeBrowseCursor({ id: "9223372036854775808", price: "1" }, identity);
    expect(() => decodeBrowseCursor(raw, identity)).toThrow("Invalid marketplace cursor");
  });
  it("binds exact wei bounds and normalized owner/search", () => {
    const identity = browseIdentity({ minPriceWei: "1" }, "0xABC", "Skate");
    const raw = encodeBrowseCursor({ id: "24", price: "2" }, identity);
    expect(
      decodeBrowseCursor(raw, browseIdentity({ minPriceWei: "1" }, "0xabc", "Skate")),
    ).toMatchObject({ id: "24", price: "2" });
    expect(() =>
      decodeBrowseCursor(raw, browseIdentity({ minPriceWei: "2" }, "0xabc", "Skate")),
    ).toThrow();
  });
});
