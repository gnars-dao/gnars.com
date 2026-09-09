import type { PoolConfig } from "pg";

export function marketplaceDatabaseConnection(
  connectionString: string,
  certificate?: string,
): Pick<PoolConfig, "connectionString" | "ssl"> {
  const ca = certificate?.trim();
  if (!ca) return { connectionString };

  // pg lets URL SSL parameters replace its explicit TLS options, including the CA.
  const url = new URL(connectionString);
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("ssl") || key.toLowerCase() === "uselibpqcompat") {
      url.searchParams.delete(key);
    }
  }
  return {
    connectionString: url.toString(),
    ssl: { ca: ca.replace(/\\n/g, "\n"), rejectUnauthorized: true },
  };
}
