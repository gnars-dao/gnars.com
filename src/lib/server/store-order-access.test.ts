import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOrderAccessToken, verifyOrderAccessToken } from "./store-order-access";

vi.mock("@/services/keepkey-dropship", () => ({ isSandbox: () => false }));
vi.mock("@/lib/rpc", () => ({ serverPublicClient: {} }));
const order = { keepKeyOrderId: "order-123", externalOrderId: "gnars-payment-123" };

describe("order tracking access", () => {
  beforeEach(() => {
    vi.stubEnv("KEEPKEY_DROPSHIP_LIVE_TOKEN", "test-only-secret");
  });
  const request = (token: string) =>
    new Request("https://gnars.com/api/store/orders", {
      headers: { "x-gnars-order-token": token },
    });
  it("accepts a valid scoped token", () => {
    expect(() =>
      verifyOrderAccessToken(request(createOrderAccessToken(order)), order),
    ).not.toThrow();
  });
  it("rejects missing, tampered and other-order tokens", () => {
    const token = createOrderAccessToken(order);
    expect(() => verifyOrderAccessToken(new Request("https://gnars.com"), order)).toThrow();
    expect(() => verifyOrderAccessToken(request(`x${token}`), order)).toThrow();
    expect(() => verifyOrderAccessToken(request(token), { keepKeyOrderId: "other" })).toThrow();
    expect(() => verifyOrderAccessToken(request(token), { externalOrderId: "other" })).toThrow();
  });
  it("excludes previous tokens and unrelated fields when renewing a completed order", () => {
    const completed = {
      ...order,
      orderAccessToken: createOrderAccessToken(order),
      status: "shipped",
      sandbox: false,
      customerEmail: "buyer@example.com",
      expiresAt: 1,
    };
    const renewed = createOrderAccessToken(completed);
    const payload = JSON.parse(Buffer.from(renewed.split(".")[0], "base64url").toString("utf8"));
    expect(payload).toEqual({
      keepKeyOrderId: order.keepKeyOrderId,
      externalOrderId: order.externalOrderId,
      expiresAt: expect.any(Number),
    });
    expect(payload.expiresAt).toBeGreaterThan(Date.now());
    expect(() => verifyOrderAccessToken(request(renewed), order)).not.toThrow();
  });
  it("rejects expired tokens", () => {
    const token = createOrderAccessToken(order);
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 91 * 86400_000);
    expect(() => verifyOrderAccessToken(request(token), order)).toThrow();
    now.mockRestore();
  });
});
