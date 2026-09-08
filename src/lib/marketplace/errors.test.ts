import { describe, expect, it } from "vitest";
import { MarketplaceApiError, parseMarketplaceApiError } from "./errors";

describe("marketplace API errors", () => {
  it("preserves a permanent provider rejection even when an older gateway returns 503", () => {
    const error = parseMarketplaceApiError(
      {
        error: "Order rejected.",
        code: "OPENSEA_ORDER_REJECTED",
        retryable: false,
        requestId: "request-123",
      },
      503,
    );
    expect(error).toBeInstanceOf(MarketplaceApiError);
    expect(error).toMatchObject({
      message: "Order rejected.",
      code: "OPENSEA_ORDER_REJECTED",
      retryable: false,
      requestId: "request-123",
      status: 503,
    });
  });
  it("supports legacy errors and bounds untrusted error metadata", () => {
    expect(parseMarketplaceApiError({ error: "Unavailable" }, 503)).toMatchObject({
      retryable: true,
      code: "REQUEST_FAILED",
    });
    expect(parseMarketplaceApiError({ error: "Invalid" }, 400)).toMatchObject({ retryable: false });
    const error = parseMarketplaceApiError(
      { code: "<script>", requestId: "https://secret.example", error: "x".repeat(2000) },
      500,
    );
    expect(error.code).toBe("REQUEST_FAILED");
    expect(error.requestId).toBeUndefined();
    expect(error.message).toHaveLength(500);
  });
});
