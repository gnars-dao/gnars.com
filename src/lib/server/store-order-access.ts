import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { RequestSecurityError } from "@/lib/server/request-security";
import { isSandbox } from "@/services/keepkey-dropship";

function signingKey() {
  const key = isSandbox()
    ? process.env.KEEPKEY_DROPSHIP_TEST_TOKEN
    : process.env.KEEPKEY_DROPSHIP_LIVE_TOKEN;
  if (!key) throw new RequestSecurityError(503, "Order access is not configured.");
  return createHmac("sha256", key).update("gnars-order-access-v1").digest();
}

export function createOrderAccessToken(order: { keepKeyOrderId: string; externalOrderId: string }) {
  const payload = Buffer.from(
    JSON.stringify({
      keepKeyOrderId: order.keepKeyOrderId,
      externalOrderId: order.externalOrderId,
      expiresAt: Date.now() + 90 * 86400_000,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", signingKey()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyOrderAccessToken(
  request: Request,
  expected: { keepKeyOrderId?: string; externalOrderId?: string },
) {
  const token = request.headers.get("x-gnars-order-token");
  if (!token || token.length > 2048)
    throw new RequestSecurityError(401, "Order authorization is required.");
  const parts = token.split(".");
  if (parts.length !== 2) throw new RequestSecurityError(401, "Invalid order authorization.");
  const [payload, signature] = parts;
  const supplied = Buffer.from(signature, "base64url");
  const correct = createHmac("sha256", signingKey()).update(payload).digest();
  if (supplied.length !== correct.length || !timingSafeEqual(supplied, correct)) {
    throw new RequestSecurityError(401, "Invalid order authorization.");
  }
  let order: { keepKeyOrderId?: string; externalOrderId?: string; expiresAt?: number };
  try {
    order = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new RequestSecurityError(401, "Invalid order authorization.");
  }
  if (
    !order ||
    !order.expiresAt ||
    order.expiresAt < Date.now() ||
    (expected.keepKeyOrderId && order.keepKeyOrderId !== expected.keepKeyOrderId) ||
    (expected.externalOrderId && order.externalOrderId !== expected.externalOrderId)
  ) {
    throw new RequestSecurityError(403, "Order authorization does not match this order.");
  }
}
