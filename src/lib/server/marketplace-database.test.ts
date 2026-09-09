import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { marketplaceDatabaseConnection } from "./marketplace-database";

describe("marketplace database TLS", () => {
  const connectionString = "postgres://app:password@localhost:6543/postgres";
  const ca = "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----";

  it("preserves existing connection behavior without a custom CA", () => {
    const legacy = `${connectionString}?sslmode=require&application_name=marketplace`;
    expect(marketplaceDatabaseConnection(legacy)).toEqual({ connectionString: legacy });
    expect(marketplaceDatabaseConnection(legacy, " ")).toEqual({ connectionString: legacy });
  });

  it("enforces certificate verification with the supplied CA", () => {
    expect(marketplaceDatabaseConnection(connectionString, ca)).toEqual({
      connectionString,
      ssl: { ca, rejectUnauthorized: true },
    });
  });

  it("accepts escaped newlines from environment configuration", () => {
    expect(
      marketplaceDatabaseConnection(connectionString, ` ${ca.replace(/\n/g, "\\n")} `).ssl,
    ).toEqual({ ca, rejectUnauthorized: true });
  });

  it.each(["disable", "no-verify", "require", "verify-ca"])(
    "prevents URL sslmode=%s from replacing explicit TLS verification",
    (mode) => {
      const options = marketplaceDatabaseConnection(
        `${connectionString}?sslmode=${mode}&ssl=0&sslrootcert=/missing-ca&sslcert=/missing-cert&sslkey=/missing-key&uselibpqcompat=true&application_name=marketplace`,
        ca,
      );
      expect(new URL(options.connectionString!).search).toBe("?application_name=marketplace");
      // Constructing the real pg client exercises URL/config precedence without connecting.
      const client = new Client(options);
      expect(client.ssl).toEqual({ ca, rejectUnauthorized: true });
    },
  );
});
