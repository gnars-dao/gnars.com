import { beforeEach, describe, expect, it, vi } from "vitest";
import { walletAuthorizationMessage, walletPayloadDigest } from "@/lib/wallet-authorization";
import { enforceRateLimit, readJsonBody, verifyWalletAuthorization } from "./request-security";

const { verifyMessage } = vi.hoisted(() => ({ verifyMessage: vi.fn() }));
vi.mock("viem/actions", () => ({ verifyMessage }));
vi.mock("@/lib/rpc", () => ({ serverPublicClient: { chain: { id: 8453 } } }));

const authorization = {
  walletAddress: "0x1111111111111111111111111111111111111111",
  issuedAt: Date.now(),
  nonce: "81e4edb3-8853-4f68-945b-e5cb8603b572",
  signature: "0x1234",
};
const request = {
  method: "POST",
  path: "/api/pinata/signed-url",
  payload: { size: 12, mimeType: "image/png" },
};

describe("wallet request authorization", () => {
  beforeEach(() => {
    verifyMessage.mockReset();
    verifyMessage.mockResolvedValue(true);
  });

  it("binds path, method, payload and wallet to the verified signature", async () => {
    await expect(verifyWalletAuthorization({ authorization, ...request })).resolves.toBe(
      authorization.walletAddress,
    );
    expect(verifyMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        address: authorization.walletAddress,
        message: walletAuthorizationMessage(authorization, request),
        signature: authorization.signature,
      }),
    );
    expect(walletAuthorizationMessage(authorization, request)).not.toBe(
      walletAuthorizationMessage(authorization, { ...request, path: "/api/store/checkout" }),
    );
    expect(walletPayloadDigest({ a: 1, b: 2 })).toBe(walletPayloadDigest({ b: 2, a: 1 }));
    expect(walletPayloadDigest({ size: 12 })).not.toBe(walletPayloadDigest({ size: 13 }));
  });

  it("rejects unsigned, expired, future and malformed requests before RPC", async () => {
    for (const auth of [
      undefined,
      { ...authorization, issuedAt: Date.now() - 600_000 },
      { ...authorization, issuedAt: Date.now() + 60_000 },
      { ...authorization, walletAddress: "bad" },
    ]) {
      await expect(
        verifyWalletAuthorization({ authorization: auth, ...request }),
      ).rejects.toMatchObject({ status: 401 });
    }
    expect(verifyMessage).not.toHaveBeenCalled();
  });

  it("rejects an invalid signature and distinguishes RPC outage", async () => {
    verifyMessage.mockResolvedValueOnce(false);
    await expect(verifyWalletAuthorization({ authorization, ...request })).rejects.toMatchObject({
      status: 401,
    });
    verifyMessage.mockRejectedValueOnce(new Error("offline"));
    await expect(verifyWalletAuthorization({ authorization, ...request })).rejects.toMatchObject({
      status: 503,
    });
  });
});

describe("bounded requests", () => {
  it("rejects oversized streamed bodies without trusting content-length", async () => {
    const request = new Request("https://gnars.com/api/test", {
      method: "POST",
      body: JSON.stringify({ value: "a".repeat(50) }),
    });
    await expect(readJsonBody(request, 20)).rejects.toMatchObject({ status: 413 });
  });
  it("uses byte limits for multibyte JSON", async () => {
    const request = new Request("https://gnars.com/api/test", {
      method: "POST",
      body: JSON.stringify({ value: "\u00e9".repeat(10) }),
    });
    await expect(readJsonBody(request, 25)).rejects.toMatchObject({ status: 413 });
  });
  it("enforces per-subject limits and returns a retry interval", async () => {
    const req = new Request("https://gnars.com");
    const policy = {
      scope: "unit-test",
      subject: crypto.randomUUID(),
      limit: 2,
      windowSeconds: 60,
    };
    await enforceRateLimit(req, policy);
    await enforceRateLimit(req, policy);
    await expect(enforceRateLimit(req, policy)).rejects.toMatchObject({
      status: 429,
      retryAfter: 60,
    });
  });
});
