import "server-only";
import { Pool } from "pg";
import type { CheckoutResult } from "@/lib/schemas/checkout";
import { RequestSecurityError } from "@/lib/server/request-security";
import { walletPayloadDigest } from "@/lib/wallet-authorization";

let pool: Pool | undefined;

function connectionString() {
  return (
    process.env.ROUNDS_DATABASE_URL || process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL
  );
}

function database() {
  const url = connectionString();
  if (!url) throw new RequestSecurityError(503, "Payment storage is not configured.");
  pool ??= new Pool({
    connectionString: url,
    max: 2,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
  });
  return pool;
}

export async function isPaymentStorageReady(): Promise<boolean> {
  if (!connectionString()) return false;
  try {
    await database().query(
      "SELECT chain_id, tx_hash, payer, payload_digest, result FROM store_payment_claims LIMIT 0",
    );
    return true;
  } catch {
    return false;
  }
}

/** Reserves a payment permanently for one payer and one exact order payload. */
export async function claimCheckoutPayment(txHash: string, payer: string, payload: unknown) {
  const hash = txHash.toLowerCase();
  const wallet = payer.toLowerCase();
  const digest = walletPayloadDigest(payload);
  await database().query(
    `INSERT INTO store_payment_claims (chain_id, tx_hash, payer, payload_digest)
     VALUES (8453, $1, $2, $3) ON CONFLICT (chain_id, tx_hash) DO NOTHING`,
    [hash, wallet, digest],
  );
  const result = await database().query<{
    payer: string;
    payload_digest: string;
    result: CheckoutResult | null;
  }>(
    "SELECT payer, payload_digest, result FROM store_payment_claims WHERE chain_id = 8453 AND tx_hash = $1",
    [hash],
  );
  const claim = result.rows[0];
  if (!claim || claim.payer !== wallet || claim.payload_digest !== digest) {
    throw new RequestSecurityError(
      409,
      "This payment is already reserved for different order details.",
    );
  }
  return claim.result;
}

export async function completeCheckoutPayment(
  txHash: string,
  result: CheckoutResult,
): Promise<boolean> {
  const saved = await database().query(
    `UPDATE store_payment_claims SET result = $2::jsonb, completed_at = now()
     WHERE chain_id = 8453 AND tx_hash = $1 AND result IS NULL`,
    [txHash.toLowerCase(), JSON.stringify(result)],
  );
  return saved.rowCount === 1;
}
