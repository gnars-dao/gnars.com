import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, readFileSync } from "node:fs";
import { Client } from "pg";

// Explicit modes: inspect (default), provision a fresh database, smoke test, or publish envs.
const mode = process.argv[2] ?? "inspect";
const projectRef = process.argv[3];
const envFile = ".env.local";
const role = "gnars_marketplace";
const caUrl =
  "https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt";
process.loadEnvFile(envFile);

function connection(url, ca) {
  return new Client({
    connectionString: url,
    ssl: { ca, rejectUnauthorized: true },
    connectionTimeoutMillis: 10000,
    query_timeout: 10000,
    statement_timeout: 10000,
  });
}

function checkedUrl(value, user, port) {
  const url = new URL(value);
  assert.equal(url.protocol, "postgresql:");
  assert.equal(url.username, `${user}.${projectRef}`);
  assert(url.hostname.endsWith(".pooler.supabase.com"));
  assert.equal(url.port, port);
  assert.equal(url.pathname, "/postgres");
  assert.equal(url.search, "", "Use the dashboard URL without SSL query overrides");
  assert(url.password && !url.password.includes("YOUR-PASSWORD"));
  return url;
}

async function denied(client, sql) {
  await client.query("SAVEPOINT denied_operation");
  let rejected = false;
  try {
    await client.query(sql);
  } catch (error) {
    assert.equal(error.code, "42501");
    rejected = true;
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT denied_operation");
  }
  assert(rejected, "Runtime role has an unexpected privilege");
}

async function smoke(url, ca) {
  checkedUrl(url, role, "6543");
  const client = connection(url, ca);
  const hash = `0x${randomBytes(32).toString("hex")}`;
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [hash]);
    const flags = await client.query(
      "SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    assert(Object.values(flags.rows[0]).every((value) => value === false));
    const inserted = await client.query(
      `INSERT INTO public.marketplace_orders
       (chain_id, order_hash, token_id, seller, price_wei, expires_at, signed_order)
       VALUES (8453, $1, 0, $2, 1, 1, '{}'::jsonb) RETURNING order_hash`,
      [hash, `0x${"0".repeat(40)}`],
    );
    assert.equal(inserted.rowCount, 1);
    assert.equal(
      (
        await client.query(
          "SELECT order_hash FROM public.marketplace_orders WHERE order_hash = $1",
          [hash],
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await client.query(
          "UPDATE public.marketplace_orders SET status = 'expired' WHERE order_hash = $1",
          [hash],
        )
      ).rowCount,
      1,
    );
    for (let hits = 1; hits <= 2; hits++) {
      const budget = await client.query(
        `INSERT INTO public.marketplace_rate_limits (bucket, hits, expires_at) VALUES ($1, 1, 1)
         ON CONFLICT (bucket) DO UPDATE SET hits = marketplace_rate_limits.hits + 1 RETURNING hits`,
        [hash],
      );
      assert.equal(budget.rows[0].hits, hits);
    }
    assert.equal(
      (await client.query("DELETE FROM public.marketplace_rate_limits WHERE bucket = $1", [hash]))
        .rowCount,
      1,
    );
    await denied(client, "DELETE FROM public.marketplace_orders WHERE false");
    await denied(client, "CREATE TABLE public.marketplace_forbidden_probe (id integer)");
    await denied(client, "SELECT id FROM auth.users LIMIT 0");
    await client.query("ROLLBACK");
    assert.equal(
      (
        await client.query(
          "SELECT order_hash FROM public.marketplace_orders WHERE order_hash = $1",
          [hash],
        )
      ).rowCount,
      0,
    );
    console.log(
      "PASS runtime TLS, RLS CRUD, budget upsert/delete, advisory lock, forbidden operations, rollback",
    );
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
}

function publishEnv() {
  const linked = JSON.parse(readFileSync(".vercel/project.json", "utf8"));
  assert.equal(linked.projectName, "gnars.com");
  for (const key of ["MARKETPLACE_DATABASE_URL", "MARKETPLACE_DATABASE_SSL_CA"]) {
    const result = spawnSync(
      "vercel",
      [
        "api",
        `/v10/projects/${linked.projectId}/env?teamId=${linked.orgId}&upsert=true`,
        "--method",
        "POST",
        "--input",
        "-",
        "--raw",
      ],
      {
        input: JSON.stringify({
          key,
          value: process.env[key],
          type: "encrypted",
          target: ["production"],
        }),
        encoding: "utf8",
      },
    );
    assert.equal(
      result.status,
      0,
      "Vercel environment update failed; response withheld to protect credentials",
    );
    const payload = JSON.parse(result.stdout);
    assert(!payload.error && !payload.errors?.length, "Vercel rejected environment update");
    console.log(`Configured ${key} in Production only`);
  }
}

async function main() {
  assert(["inspect", "provision", "smoke", "publish-env"].includes(mode));
  assert(/^[a-z]{20}$/.test(projectRef ?? ""), "Pass the expected Supabase project ref explicitly");
  if (mode === "smoke" || mode === "publish-env") {
    assert(process.env.MARKETPLACE_DATABASE_SSL_CA, "Runtime certificate missing");
    await smoke(process.env.MARKETPLACE_DATABASE_URL, process.env.MARKETPLACE_DATABASE_SSL_CA);
    if (mode === "publish-env") publishEnv();
    return;
  }
  const adminUrl = checkedUrl(process.env.SUPABASE_DATABASE_URL, "postgres", "5432");
  const response = await fetch(caUrl, { signal: AbortSignal.timeout(10000) });
  assert(response.ok, "Unable to download the official Supabase CA");
  const ca = await response.text();
  assert(ca.startsWith("-----BEGIN CERTIFICATE-----"));
  const admin = connection(adminUrl.toString(), ca);
  try {
    await admin.connect();
    const tables = await admin.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    const roles = await admin.query("SELECT rolname FROM pg_roles WHERE rolname = $1", [role]);
    console.log(
      JSON.stringify({
        tlsVerified: true,
        publicTables: tables.rows.map((row) => row.tablename),
        runtimeRoleExists: roles.rowCount > 0,
      }),
    );
    if (mode !== "provision") return;
    assert.equal(
      tables.rowCount,
      0,
      "Fresh setup only: inspect existing tables instead of overwriting them",
    );
    assert.equal(roles.rowCount, 0, "Runtime role already exists; no password rotation performed");
    assert(
      !process.env.MARKETPLACE_DATABASE_URL && !process.env.MARKETPLACE_DATABASE_SSL_CA,
      "Local runtime configuration already exists",
    );
    const password = randomBytes(32).toString("base64url");
    const runtime = new URL(adminUrl);
    runtime.username = `${role}.${projectRef}`;
    runtime.password = password;
    runtime.port = "6543";
    await admin.query("BEGIN");
    const createRole = await admin.query(
      "SELECT format('CREATE ROLE gnars_marketplace LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', $1::text) AS sql",
      [password],
    );
    await admin.query(createRole.rows[0].sql);
    await admin.query(readFileSync("scripts/marketplace-schema.sql", "utf8"));
    await admin.query(readFileSync("scripts/marketplace-supabase-security.sql", "utf8"));
    const deniedRoles = await admin.query(
      `SELECT bool_and(NOT has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE')) AS denied
       FROM unnest(ARRAY['anon','authenticated','service_role']) r
       CROSS JOIN unnest(ARRAY['public.marketplace_orders','public.marketplace_rate_limits']) t`,
    );
    assert.equal(deniedRoles.rows[0].denied, true);
    // Persist generated credentials before commit so an interrupted setup cannot lose them.
    chmodSync(envFile, 0o600);
    appendFileSync(
      envFile,
      `\nMARKETPLACE_DATABASE_URL="${runtime}"\nMARKETPLACE_DATABASE_SSL_CA="${ca.trim()}"\n`,
      { mode: 0o600 },
    );
    await admin.query("COMMIT");
    console.log(
      "Created marketplace tables, protected Data API access, and generated a dedicated runtime role",
    );
    await smoke(runtime.toString(), ca);
  } finally {
    await admin.query("ROLLBACK").catch(() => {});
    await admin.end();
  }
}

main().catch((error) => {
  // Database and CLI errors can contain connection details or generated passwords.
  console.error(JSON.stringify({ failed: true, mode, code: error.code ?? error.name }));
  process.exitCode = 1;
});
