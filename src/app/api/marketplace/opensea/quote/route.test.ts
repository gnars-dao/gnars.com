import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequestSecurityError } from "@/lib/server/request-security";
import { POST } from "./route";

const quote = vi.hoisted(() => vi.fn());
vi.mock("@/services/marketplace-opensea", () => ({ getOpenSeaListingQuote: quote }));
beforeEach(() => vi.clearAllMocks());

function request(body: unknown) {
  return new Request("https://gnars.com/api/marketplace/opensea/quote", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("OpenSea fee quote boundaries", () => {
  it.each([
    { tokenId: "12", priceWei: "0" },
    { tokenId: "../12", priceWei: "100" },
    { tokenId: "12", priceWei: "1e18" },
    { tokenId: "12", priceWei: "100", collection: "another" },
  ])("rejects malformed inputs before provider work", async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(quote).not.toHaveBeenCalled();
  });
  it("bounds body size before provider work", async () => {
    expect((await POST(request({ priceWei: "1".repeat(2000) }))).status).toBe(413);
    expect(quote).not.toHaveBeenCalled();
  });
  it("returns only a no-store quote without depending on order storage", async () => {
    quote.mockResolvedValueOnce({ priceWei: "100", sellerWei: "99", fees: [] });
    const response = await POST(request({ tokenId: "12", priceWei: "100" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      quote: { priceWei: "100", sellerWei: "99", fees: [] },
    });
    expect(quote).toHaveBeenCalledExactlyOnceWith("100");
  });
  it("preserves provider cooldown without exposing provider errors or credentials", async () => {
    quote.mockRejectedValueOnce(new RequestSecurityError(503, "OpenSea is unavailable.", 90));
    const response = await POST(request({ tokenId: "12", priceWei: "100" }));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("90");
  });
});
