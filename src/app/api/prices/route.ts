import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { z } from "zod";
import {
  enforceRateLimit,
  readJsonBody,
  RequestSecurityError,
  requestSecurityResponse,
} from "@/lib/server/request-security";
import { getEthUsd, getTokenPricesUsd, type UsdPrice } from "@/services/prices";

/**
 * Thin wrapper over `services/prices` — see that module for provider choice,
 * TTL and failure semantics.
 *
 * A price of `null` means "unknown", never "$0". Callers must branch on it.
 *
 * WETH stays special-cased to the ETH feed (they are 1:1 by construction, and
 * Alchemy's ETH price is the fresher of the two), which is what the previous
 * implementation did too.
 */
export const dynamic = "force-dynamic";

const CDN_TTL_SECONDS = 300;
const WETH_ADDRESS_BASE = "0x4200000000000000000000000000000000000006";

const addressesSchema = z
  .array(z.string().refine(isAddress))
  .min(1)
  .max(100)
  .transform((addresses) => [...new Set(addresses.map((address) => address.toLowerCase()))].sort());

async function handlePrices(addresses: string[]) {
  if (addresses.length === 0) {
    return NextResponse.json({ error: "addresses required" }, { status: 400 });
  }

  const weth = WETH_ADDRESS_BASE.toLowerCase();
  const wantsWeth = addresses.includes(weth);
  const tokenAddresses = addresses.filter((a) => a !== weth);

  const [tokenPrices, ethUsd] = await Promise.all([
    getTokenPricesUsd(tokenAddresses, "base"),
    wantsWeth ? getEthUsd() : Promise.resolve(null),
  ]);

  const prices: Record<string, { usd: UsdPrice }> = {};
  for (const [address, usd] of Object.entries(tokenPrices)) {
    prices[address] = { usd };
  }
  if (wantsWeth) prices[weth] = { usd: ethUsd };

  // A partial provider outage must not occupy the healthy CDN cache window.
  const fullyResolved =
    Object.values(prices).length > 0 && Object.values(prices).every((p) => p.usd !== null);

  return NextResponse.json(
    { prices },
    {
      headers: fullyResolved
        ? {
            "Cache-Control": `public, s-maxage=${CDN_TTL_SECONDS}, stale-while-revalidate=${CDN_TTL_SECONDS * 2}`,
          }
        : { "Cache-Control": "no-store" },
    },
  );
}

export async function GET(request: Request) {
  try {
    await enforceRateLimit(request, { scope: "prices", limit: 60, windowSeconds: 60 });
    const { searchParams } = new URL(request.url);
    const parsed = addressesSchema.safeParse((searchParams.get("addresses") || "").split(","));
    if (!parsed.success)
      throw new RequestSecurityError(400, "Invalid addresses. Maximum batch size is 100.");
    return await handlePrices(parsed.data);
  } catch (error) {
    return requestSecurityResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    await enforceRateLimit(req, { scope: "prices", limit: 60, windowSeconds: 60 });
    const parsed = z
      .object({ addresses: addressesSchema })
      .strict()
      .safeParse(await readJsonBody(req, 8192));
    if (!parsed.success)
      throw new RequestSecurityError(400, "Invalid addresses. Maximum batch size is 100.");
    const response = await handlePrices(parsed.data.addresses);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return requestSecurityResponse(error);
  }
}
