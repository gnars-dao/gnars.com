import { unstable_cache } from "next/cache";
import { NextResponse } from "next/server";
import { isAddress, type Address } from "viem";
import { z } from "zod";
import { mapConcurrent } from "@/lib/server/map-concurrent";
import {
  enforceRateLimit,
  readJsonBody,
  RequestSecurityError,
  requestSecurityResponse,
} from "@/lib/server/request-security";

const addressSchema = z
  .string()
  .refine(isAddress)
  .transform((value) => value.toLowerCase() as Address);
const requestSchema = z.union([
  z.object({ address: addressSchema }).strict(),
  z.object({ addresses: z.array(addressSchema).min(1).max(50) }).strict(),
  z
    .object({
      name: z
        .string()
        .trim()
        .min(3)
        .max(255)
        .includes(".")
        .transform((value) => value.toLowerCase()),
    })
    .strict(),
]);
const reverseSchema = z
  .object({
    name: z.string().nullable().optional(),
    displayName: z.string().nullable().optional(),
    avatar: z.string().nullable().optional(),
    address: z.string().refine(isAddress).nullable().optional(),
  })
  .refine((value) => "name" in value || "displayName" in value || "address" in value);
const forwardSchema = z.object({ address: addressSchema.nullable() });
const cacheHeaders = { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" };

async function fetchResolution(query: string, forward: boolean) {
  for (const base of [
    "https://api.ensideas.com/ens/resolve/",
    "https://ens.resolver.eth.link/resolve/",
  ]) {
    try {
      const response = await fetch(`${base}${encodeURIComponent(query)}`, {
        headers: { Accept: "application/json", "User-Agent": "gnars-website/ens" },
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) continue;
      const parsed = (forward ? forwardSchema : reverseSchema).safeParse(await response.json());
      if (parsed.success) return parsed.data;
    } catch {
      // Try the secondary provider; outages must not become cached negative answers.
    }
  }
  throw new RequestSecurityError(502, "ENS service is unavailable.");
}

const cachedResolution = unstable_cache(fetchResolution, ["ens-resolution-v2"], {
  revalidate: 3600,
});
const pending = new Map<string, ReturnType<typeof cachedResolution>>();

function resolve(query: string, forward: boolean) {
  const key = `${forward}:${query}`;
  const current = pending.get(key);
  if (current) return current;
  const promise = cachedResolution(query, forward).finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

async function resolveAddress(address: Address) {
  const result = reverseSchema.parse(await resolve(address, false));
  const name = result.name || result.displayName || null;
  return {
    address,
    name,
    avatar: result.avatar ?? null,
    displayName: name || `${address.slice(0, 6)}...${address.slice(-4)}`,
  };
}

async function handle(request: Request, raw: unknown) {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success)
    throw new RequestSecurityError(400, "Invalid ENS lookup. Maximum batch size is 50.");
  const input = parsed.data;
  const addresses = "addresses" in input ? [...new Set(input.addresses)] : null;
  await enforceRateLimit(request, {
    scope: "ens",
    limit: 120,
    windowSeconds: 60,
    cost: addresses?.length ?? 1,
  });
  const headers = request.method === "GET" ? cacheHeaders : { "Cache-Control": "no-store" };
  if ("name" in input) {
    const result = forwardSchema.parse(await resolve(input.name, true));
    return NextResponse.json({ address: result.address }, { headers });
  }
  if ("address" in input)
    return NextResponse.json({ ens: await resolveAddress(input.address) }, { headers });
  const entries = await mapConcurrent(
    addresses!,
    async (address) => [address, await resolveAddress(address)] as const,
    5,
  );
  return NextResponse.json({ ensMap: Object.fromEntries(entries) }, { headers });
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const raw: Record<string, unknown> = Object.fromEntries(params);
    if (typeof raw.addresses === "string") raw.addresses = raw.addresses.split(",");
    return await handle(request, raw);
  } catch (error) {
    return requestSecurityResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    return await handle(request, await readJsonBody(request, 8192));
  } catch (error) {
    return requestSecurityResponse(error);
  }
}
