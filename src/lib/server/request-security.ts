import "server-only";
import { createHash } from "node:crypto";
import { isAddress, type Address } from "viem";
import { verifyMessage } from "viem/actions";
import { z } from "zod";
import { serverPublicClient } from "@/lib/rpc";
import { WALLET_AUTH_MAX_AGE_MS, walletAuthorizationMessage } from "@/lib/wallet-authorization";

export class RequestSecurityError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
  }
}

const authorizationSchema = z.object({
  walletAddress: z.string().refine(isAddress),
  issuedAt: z.number().int().positive(),
  nonce: z.string().uuid(),
  signature: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/)
    .max(16384),
});

export async function verifyWalletAuthorization({
  authorization,
  ...request
}: {
  authorization: unknown;
  method: string;
  path: string;
  payload: unknown;
}): Promise<Address> {
  const parsed = authorizationSchema.safeParse(authorization);
  if (!parsed.success) throw new RequestSecurityError(401, "Signed wallet request is required.");
  const age = Date.now() - parsed.data.issuedAt;
  if (age < -30_000 || age > WALLET_AUTH_MAX_AGE_MS) {
    throw new RequestSecurityError(401, "Wallet authorization expired. Sign again.");
  }
  let verified = false;
  try {
    verified = await verifyMessage(serverPublicClient, {
      address: parsed.data.walletAddress as Address,
      message: walletAuthorizationMessage(parsed.data, request),
      signature: parsed.data.signature as `0x${string}`,
    });
  } catch {
    throw new RequestSecurityError(503, "Unable to verify wallet authorization. Try again.");
  }
  if (!verified) throw new RequestSecurityError(401, "Invalid wallet authorization.");
  return parsed.data.walletAddress.toLowerCase() as Address;
}

export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (declared > maxBytes) throw new RequestSecurityError(413, "Request body too large.");
  if (!request.body) throw new RequestSecurityError(400, "JSON body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new RequestSecurityError(413, "Request body too large.");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof RequestSecurityError) throw error;
    throw new RequestSecurityError(400, "Invalid JSON body.");
  } finally {
    reader.releaseLock();
  }
}

const buckets = new Map<string, { count: number; resetAt: number }>();
const MAX_BUCKETS = 5000;

/** Secondary per-instance guard. Vercel WAF supplies the distributed IP limit. */
export async function enforceRateLimit(
  request: Request,
  options: { scope: string; limit: number; windowSeconds: number; subject?: string; cost?: number },
) {
  const subject = options.subject ?? request.headers.get("x-vercel-forwarded-for") ?? "local";
  const key = createHash("sha256").update(`${options.scope}:${subject}`).digest("hex");
  const now = Date.now();
  if (buckets.size >= MAX_BUCKETS) {
    for (const [bucketKey, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(bucketKey);
    }
    if (!buckets.has(key) && buckets.size >= MAX_BUCKETS) {
      throw new RequestSecurityError(429, "Too many requests. Try again later.", 60);
    }
  }
  const existing = buckets.get(key);
  const bucket =
    existing && existing.resetAt > now
      ? existing
      : { count: 0, resetAt: now + options.windowSeconds * 1000 };
  const cost = options.cost ?? 1;
  if (bucket.count + cost > options.limit) {
    throw new RequestSecurityError(
      429,
      "Too many requests. Try again later.",
      Math.ceil((bucket.resetAt - now) / 1000),
    );
  }
  bucket.count += cost;
  buckets.set(key, bucket);
}

export function requestSecurityResponse(error: unknown): Response {
  const known = error instanceof RequestSecurityError;
  return Response.json(
    { error: known ? error.message : "Unable to complete request." },
    {
      status: known ? error.status : 500,
      headers: {
        "Cache-Control": "no-store",
        ...(known && error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {}),
      },
    },
  );
}
