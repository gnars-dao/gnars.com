import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

const mocks = vi.hoisted(() => ({
  verifyWalletAuthorization: vi.fn(),
  verifyUsdcPayment: vi.fn(),
  isPaymentStorageReady: vi.fn(),
  claimCheckoutPayment: vi.fn(),
  completeCheckoutPayment: vi.fn(),
  createDropshipOrder: vi.fn(),
  sendOrderReceiptEmail: vi.fn(),
}));
vi.mock("@/lib/rpc", () => ({ serverPublicClient: {} }));
vi.mock("@/lib/server/request-security", async () => ({
  ...(await vi.importActual("@/lib/server/request-security")),
  verifyWalletAuthorization: mocks.verifyWalletAuthorization,
  enforceRateLimit: vi.fn(),
}));
vi.mock("@/services/store-payment", () => ({ verifyUsdcPayment: mocks.verifyUsdcPayment }));
vi.mock("@/services/store-payment-claims", () => ({
  isPaymentStorageReady: mocks.isPaymentStorageReady,
  claimCheckoutPayment: mocks.claimCheckoutPayment,
  completeCheckoutPayment: mocks.completeCheckoutPayment,
}));
vi.mock("@/services/store", () => ({
  getProductBySlug: async () => ({
    slug: "keepkey",
    price: 59.95,
    fulfillmentSku: "KK-1",
    title: "KeepKey",
    currency: "USD",
  }),
}));
vi.mock("@/lib/store/fulfillment", () => ({ isDropshipFulfillable: () => true }));
vi.mock("@/services/keepkey-dropship", () => ({
  createDropshipOrder: mocks.createDropshipOrder,
  isDropshipConfigured: () => true,
  isSandbox: () => false,
  DropshipApiError: class extends Error {},
}));
vi.mock("@/lib/email/order-receipt", () => ({
  sendOrderReceiptEmail: mocks.sendOrderReceiptEmail,
}));
vi.mock("@/lib/config", () => ({ STORE_CHECKOUT: { recipient: `0x${"1".repeat(40)}` } }));

const payer = `0x${"2".repeat(40)}`;
const input = {
  slug: "keepkey",
  finish: "",
  customerName: "Buyer",
  customerEmail: "buyer@example.com",
  shippingAddress: {
    line1: "123 Street",
    line2: "",
    city: "Denver",
    state: "CO",
    postalCode: "80202",
    country: "US",
    phone: "1234567890",
  },
  txHash: `0x${"A".repeat(64)}`,
};
const request = () =>
  new NextRequest("https://gnars.com/api/store/checkout", {
    method: "POST",
    body: JSON.stringify({ checkout: input, authorization: {} }),
  });

describe("checkout payment gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("KEEPKEY_DROPSHIP_LIVE_TOKEN", "test-only-token");
    mocks.verifyWalletAuthorization.mockResolvedValue(payer);
    mocks.verifyUsdcPayment.mockResolvedValue({ ok: true, from: payer });
    mocks.isPaymentStorageReady.mockResolvedValue(true);
    mocks.claimCheckoutPayment.mockResolvedValue(null);
    mocks.completeCheckoutPayment.mockResolvedValue(true);
    mocks.createDropshipOrder.mockResolvedValue({
      keepKeyOrderId: "order-1",
      status: "pending",
      sandbox: false,
    });
  });
  it("verifies the authorized payer and uses a normalized fulfillment key", async () => {
    expect((await POST(request())).status).toBe(201);
    expect(mocks.verifyUsdcPayment).toHaveBeenCalledWith(input.txHash.toLowerCase(), 59.95, payer);
    expect(mocks.createDropshipOrder).toHaveBeenCalledWith(
      expect.objectContaining({ externalOrderId: `gnars-${input.txHash.toLowerCase()}` }),
    );
    expect(mocks.claimCheckoutPayment).toHaveBeenCalledWith(
      input.txHash.toLowerCase(),
      payer,
      expect.objectContaining({ txHash: input.txHash.toLowerCase() }),
    );
  });
  it("never fulfills another payer's transfer", async () => {
    mocks.verifyUsdcPayment.mockResolvedValue({
      ok: false,
      code: "no_matching_transfer",
      message: "Wrong payer",
    });
    expect((await POST(request())).status).toBe(402);
    expect(mocks.createDropshipOrder).not.toHaveBeenCalled();
  });
  it("recovers a completed payment without fulfillment or email replay", async () => {
    mocks.claimCheckoutPayment.mockResolvedValue({ keepKeyOrderId: "existing" });
    const response = await POST(request());
    expect(await response.json()).toMatchObject({ keepKeyOrderId: "existing" });
    expect(mocks.createDropshipOrder).not.toHaveBeenCalled();
    expect(mocks.sendOrderReceiptEmail).not.toHaveBeenCalled();
  });
  it("stops checkout before payment when durable storage is unavailable", async () => {
    mocks.isPaymentStorageReady.mockResolvedValue(false);
    expect(await (await GET()).json()).toMatchObject({ ready: false });
    expect((await POST(request())).status).toBe(503);
    expect(mocks.verifyUsdcPayment).not.toHaveBeenCalled();
    expect(mocks.createDropshipOrder).not.toHaveBeenCalled();
  });
});
