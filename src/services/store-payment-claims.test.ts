import { beforeEach, describe, expect, it, vi } from "vitest";
import { walletPayloadDigest } from "@/lib/wallet-authorization";
import {
  claimCheckoutPayment,
  completeCheckoutPayment,
  isPaymentStorageReady,
} from "./store-payment-claims";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("pg", () => ({
  Pool: class {
    query = query;
  },
}));
vi.mock("@/lib/rpc", () => ({ serverPublicClient: {} }));
const tx = `0x${"a".repeat(64)}`;
const payer = `0x${"b".repeat(40)}`;
const payload = { slug: "wallet", customerName: "Customer" };

describe("durable checkout payment claims", () => {
  beforeEach(() => {
    query.mockReset();
    vi.stubEnv("DATABASE_URL", "postgres://localhost/test");
  });

  it("stores one canonical key and returns the completed order on retry", async () => {
    const completed = { keepKeyOrderId: "order-1" };
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [{ payer, payload_digest: walletPayloadDigest(payload), result: completed }],
    });
    await expect(
      claimCheckoutPayment(`0x${"A".repeat(64)}`, `0x${"B".repeat(40)}`, payload),
    ).resolves.toEqual(completed);
    expect(query.mock.calls[0][1]).toEqual([tx, payer, walletPayloadDigest(payload)]);
    expect(query.mock.calls[0][0]).toContain("ON CONFLICT (chain_id, tx_hash) DO NOTHING");
  });

  it("rejects a different payer or changed order payload", async () => {
    for (const claim of [
      { payer: `0x${"c".repeat(40)}`, payload_digest: walletPayloadDigest(payload), result: null },
      {
        payer,
        payload_digest: walletPayloadDigest({ ...payload, customerName: "Other" }),
        result: null,
      },
    ]) {
      query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [claim] });
      await expect(claimCheckoutPayment(tx, payer, payload)).rejects.toMatchObject({ status: 409 });
    }
  });

  it("marks completion once so concurrent retries do not resend email", async () => {
    const result = {
      keepKeyOrderId: "1",
      externalOrderId: "gnars-1",
      status: "pending",
      sandbox: false,
      orderAccessToken: "token",
    };
    query.mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 0 });
    expect(await completeCheckoutPayment(tx, result)).toBe(true);
    expect(await completeCheckoutPayment(tx, result)).toBe(false);
    expect(query.mock.calls[0][0]).toContain("result IS NULL");
  });

  it("fails readiness when the migration or database is unavailable", async () => {
    query.mockRejectedValueOnce(new Error("relation does not exist"));
    expect(await isPaymentStorageReady()).toBe(false);
  });
});
