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
const protocol = `0x${"1".repeat(40)}`;
const cast = `0x${"2".repeat(40)}`;
const lease = randomUUID();

try {
  await client.connect();
  await client.query("BEGIN");
  const insert = `INSERT INTO public.marketplace_announcements
    (chain_id,protocol_address,order_hash,event,idem,signer_uuid,payload)
    VALUES (8453,$1,$2,'listed',$3,$4,'{}'::jsonb)
    ON CONFLICT (chain_id,protocol_address,order_hash,event) DO NOTHING`;
  const values = [protocol, hash, randomBytes(8).toString("hex"), randomUUID()];
  assert.equal((await client.query(insert, values)).rowCount, 1);
  assert.equal((await client.query(insert, values)).rowCount, 0);
  const claim = `UPDATE public.marketplace_announcements
    SET status='sending',lease_token=$3,lease_until=NOW()+INTERVAL '45 seconds',attempts=attempts+1
    WHERE protocol_address=$1 AND order_hash=$2 AND status='queued'
      AND (lease_until IS NULL OR lease_until<NOW()) RETURNING attempts`;
  assert.equal((await client.query(claim, [protocol, hash, lease])).rowCount, 1);
  assert.equal((await client.query(claim, [protocol, hash, randomUUID()])).rowCount, 0);
  assert.equal(
    (
      await client.query(
        `UPDATE public.marketplace_announcements
    SET status='sent',cast_hash=$4,lease_token=NULL,lease_until=NULL
    WHERE protocol_address=$1 AND order_hash=$2 AND lease_token=$3`,
        [protocol, hash, lease, cast],
      )
    ).rowCount,
    1,
  );
  const saved = await client.query(
    "SELECT cast_hash,status,attempts FROM public.marketplace_announcements WHERE protocol_address=$1 AND order_hash=$2",
    [protocol, hash],
  );
  assert.deepEqual(saved.rows[0], { cast_hash: cast, status: "sent", attempts: 1 });
  for (const sql of [
    "UPDATE public.marketplace_announcements SET payload='{}'::jsonb WHERE false",
    "UPDATE public.marketplace_announcements SET idem='1234567890123456' WHERE false",
    "UPDATE public.marketplace_announcements SET signer_uuid=gen_random_uuid() WHERE false",
    "UPDATE public.marketplace_announcements SET order_hash=order_hash WHERE false",
    "DELETE FROM public.marketplace_announcements WHERE false",
  ]) {
    await client.query("SAVEPOINT denied_operation");
    await assert.rejects(client.query(sql), (error) => error.code === "42501");
    await client.query("ROLLBACK TO SAVEPOINT denied_operation");
  }
  await client.query("ROLLBACK");
  assert.equal(
    (
      await client.query(
        "SELECT order_hash FROM public.marketplace_announcements WHERE order_hash=$1",
        [hash],
      )
    ).rowCount,
    0,
  );
  console.log(
    "PASS announcement unique identity, lease exclusion, saved cast hash, immutable payload/identity and rollback; no casts sent",
  );
} catch (error) {
  console.error("Announcement database smoke failed:", error.code ?? error.name);
  process.exitCode = 1;
} finally {
  await client.query("ROLLBACK").catch(() => {});
  await client.end();
}
