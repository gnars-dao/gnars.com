import { beforeEach, describe, expect, it, vi } from "vitest";
import { DAO_ADDRESSES } from "@/lib/config";
import { POST } from "./route";

const { receipt, block, invalidate } = vi.hoisted(() => ({
  receipt: vi.fn(),
  block: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock("@/lib/rpc", () => ({
  serverPublicClient: { getTransactionReceipt: receipt, getBlock: block },
}));
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn, revalidateTag: invalidate }));
let sequence = 0;
const request = (extra: Record<string, unknown> = {}) =>
  new Request("https://gnars.com/api/revalidate", {
    method: "POST",
    body: JSON.stringify({
      tags: ["auction", "stake"],
      transactionHash: `0x${(++sequence).toString(16).padStart(64, "0")}`,
      ...extra,
    }),
  });

describe("transaction-backed refresh route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    receipt.mockResolvedValue({
      status: "success",
      blockNumber: 1n,
      logs: [{ address: DAO_ADDRESSES.auction }],
    });
    block.mockResolvedValue({ timestamp: BigInt(Math.floor(Date.now() / 1000)) });
  });

  it("refreshes only datasets affected by a recent successful transaction", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revalidated: ["auction"] });
    expect(invalidate).toHaveBeenCalledExactlyOnceWith("auction", "max");
  });
  it("rejects mined reverts", async () => {
    receipt.mockResolvedValue({ status: "reverted" });
    expect((await POST(request())).status).toBe(400);
    expect(invalidate).not.toHaveBeenCalled();
  });
  it("rejects expired transaction proofs", async () => {
    block.mockResolvedValue({ timestamp: BigInt(Math.floor(Date.now() / 1000) - 601) });
    expect((await POST(request())).status).toBe(400);
    expect(invalidate).not.toHaveBeenCalled();
  });
  it("rejects unrelated transactions", async () => {
    receipt.mockResolvedValue({ status: "success", blockNumber: 1n, logs: [] });
    expect((await POST(request())).status).toBe(403);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
