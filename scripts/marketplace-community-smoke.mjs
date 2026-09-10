import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";

process.loadEnvFile(".env.local");
const url = new URL(process.env.MARKETPLACE_DATABASE_URL);
assert(url.username.startsWith("gnars_marketplace."), "Use the restricted runtime role");
assert.equal(url.search, "", "Remove SSL URL overrides before testing");
const ca = process.env.MARKETPLACE_DATABASE_SSL_CA?.replace(/\\n/g, "\n");
assert(ca, "A trusted PostgreSQL CA is required");
const client = new Client({
  connectionString: url.href,
  ssl: { ca, rejectUnauthorized: true },
  connectionTimeoutMillis: 10000,
  statement_timeout: 10000,
  query_timeout: 10000,
});
const hash = `0x${randomBytes(32).toString("hex")}`;
const address = `0x${"1".repeat(40)}`;

async function rejects(sql, code, params) {
  await client.query("SAVEPOINT denied_operation");
  try {
    await assert.rejects(client.query(sql, params), (error) => error.code === code);
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT denied_operation");
  }
}

try {
  await client.connect();
  await client.query("BEGIN");
  const flags = await client.query(
    "SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  assert(Object.values(flags.rows[0]).every((value) => value === false));
  const insert = `INSERT INTO public.marketplace_community_orders
    (chain_id,protocol_address,order_hash,collection_address,token_id,seller,price_wei,expires_at,signed_order,fee_policy,metadata,eligibility_balance)
    VALUES (8453,$1,$2,$1,0,$1,1,1,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$3) RETURNING id`;
  await rejects(insert, "23514", [address, hash, 5]);
  assert.equal((await client.query(insert, [address, hash, 6])).rowCount, 1);
  assert.equal(
    (
      await client.query(
        "SELECT id FROM public.marketplace_community_orders WHERE order_hash=$1 FOR UPDATE",
        [hash],
      )
    ).rowCount,
    1,
  );
  const nonce = randomUUID();
  const audit = `INSERT INTO public.marketplace_community_moderation
    (nonce,actor,protocol_address,order_hash,action,expected_revision,reason,wallet_authorization)
    VALUES ($1,$2,$2,$3,'hide',0,'rollback-only probe','{}'::jsonb) ON CONFLICT (nonce) DO NOTHING RETURNING nonce`;
  assert.equal((await client.query(audit, [nonce, address, hash])).rowCount, 1);
  assert.equal((await client.query(audit, [nonce, address, hash])).rowCount, 0);
  const moderate =
    "UPDATE public.marketplace_community_orders SET hidden=true, moderation_revision=moderation_revision+1, moderated_by=$2, moderation_reason=$3, moderated_at=NOW() WHERE order_hash=$1 AND moderation_revision=0";
  assert.equal((await client.query(moderate, [hash, address, "rollback-only probe"])).rowCount, 1);
  assert.equal((await client.query(moderate, [hash, address, "rollback-only probe"])).rowCount, 0);
  const editComment = `UPDATE public.marketplace_community_orders
    SET metadata=jsonb_build_object('listingComment', 'edited', 'listingCommentRevision', 1)
    WHERE order_hash=$1 AND COALESCE((metadata->>'listingCommentRevision')::integer,0)=0`;
  assert.equal((await client.query(editComment, [hash])).rowCount, 1);
  assert.equal((await client.query(editComment, [hash])).rowCount, 0);
  assert.equal(
    (
      await client.query(
        "UPDATE public.marketplace_community_orders SET status='expired',checked_at=NOW() WHERE order_hash=$1",
        [hash],
      )
    ).rowCount,
    1,
  );
  for (const sql of [
    "DELETE FROM public.marketplace_community_orders WHERE false",
    "DELETE FROM public.marketplace_community_moderation WHERE false",
    "UPDATE public.marketplace_community_orders SET price_wei=2 WHERE false",
    "UPDATE public.marketplace_community_orders SET signed_order='{}'::jsonb WHERE false",
    "UPDATE public.marketplace_community_orders SET fee_policy='{}'::jsonb WHERE false",
    "UPDATE public.marketplace_community_moderation SET reason='tampered' WHERE false",
    "CREATE TABLE public.community_forbidden_probe (id integer)",
    "SELECT id FROM auth.users LIMIT 0",
  ])
    await rejects(sql, "42501");
  await client.query("ROLLBACK");
  assert.equal(
    (
      await client.query("SELECT id FROM public.marketplace_community_orders WHERE order_hash=$1", [
        hash,
      ])
    ).rowCount,
    0,
  );
  console.log(
    "PASS community TLS, six-holder constraint, runtime grants, immutable terms/audit, nonce replay, revision guard and rollback",
  );
} catch (error) {
  console.error("Community database smoke failed:", error.code ?? error.name);
  process.exitCode = 1;
} finally {
  await client.query("ROLLBACK").catch(() => {});
  await client.end();
}
